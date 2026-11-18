import { eventSource, event_types, isGenerating, unshallowCharacter, substituteParams, setExternalAbortController, stopGeneration, getThumbnailUrl } from '../../../../script.js';
import { buildState, DEFAULTS, substituteForParticipant, continueOverride, shouldOverrideContinue } from './context.js';
import { runTurns } from './runner.js';
import { generateGroupWrapper, is_group_automode_enabled, group_activation_strategy, editGroup } from '../../../group-chats.js';
const KEY = 'jev_speaker_router';
const API = '/api/plugins/jev-speaker-router';
let root, controller, timer, revision = 0, running = false, ownedGeneration = null, drawerOpen = false;
let castRoot = null, castCollapsed = false, castToggling = false;
const ctx = () => SillyTavern.getContext();
const activity=[];
let lastStatus='Ready.';
function trace(message) {
    activity.push(`${new Date().toISOString().slice(11,23)} ${message}`);
    if(activity.length>100) activity.shift();
    const box=root?.querySelector('[data-diagnostics]');
    if(box) box.value=activity.join('\n');
}
function settings() {
    const all = ctx().extensionSettings;
    all[KEY] ??= {profiles:{},groups:{},model:'typesafe/jev-1.13'};
    return all[KEY];
}
function groupSettings() {
    const id = String(ctx().groupId);
    const s = settings();
    return s.groups[id] ??= {...DEFAULTS};
}
const save = () => ctx().saveSettingsDebounced();
function status(text) { lastStatus=text;trace(text);if(root) root.querySelector('[data-status]').textContent = text; }
function cancel(message, stopOwned = true) {
    trace(`Cancel: ${message || 'new operation'}; owned generation=${!!ownedGeneration}; stop=${stopOwned}`);
    revision++; clearTimeout(timer); timer=null; controller?.abort();
    if (stopOwned && ownedGeneration) {
        const own=ownedGeneration; ownedGeneration=null;
        own.abort(); stopGeneration();
    }
    if (message) status(message);
}
function state() { return buildState(ctx(),settings(),(s,name)=>substituteForParticipant(substituteParams,s,name)); }
function signature() {
    const c = ctx();
    const group=c.groups.find(g=>String(g.id)===String(c.groupId));
    // Memory extensions legitimately update chat metadata and message.extra.
    // Only invalidate on fields that affect this router's inputs/eligibility.
    return JSON.stringify([c.groupId,c.chatId,c.name1,c.chatMetadata?.scenario,
        c.chat.map(m=>[m.name,m.is_user,m.is_system,m.mes,m.original_avatar,m.extra?.isSmallSys]),
        group && [group.members,group.disabled_members,group.activation_strategy],settings()]);
}
function element(tag,text) { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; return el; }
function button(text,action) {
    const b=element('button',text); b.type='button'; b.className='menu_button';
    b.addEventListener('click',()=>Promise.resolve().then(action).catch(e=>status(e.message))); return b;
}
async function prepare() {
    const before=signature();
    const c=ctx(), g=c.groups.find(g=>String(g.id)===String(c.groupId));
    if(!g) throw new Error('Open a group chat first.');
    for(const avatar of g.members) {
        const i=ctx().characters.findIndex(x=>x.avatar===avatar);
        if(i>=0) await unshallowCharacter(String(i));
    }
    if(before!==signature()) throw new Error('The conversation or settings changed. Evaluate again.');
    return state();
}
async function api(path,body,signal) {
    const response=await fetch(API+path,{method:body?'POST':'GET',headers:ctx().getRequestHeaders(),body:body?JSON.stringify(body):undefined,signal});
    let data;
    try { data=await response.json(); } catch { throw new Error('Plugin unavailable. Check server plugins are enabled, then restart SillyTavern.'); }
    if(!response.ok) throw new Error(data.error || `Plugin returned HTTP ${response.status}.`);
    return data;
}
function currentGroup() { return ctx().groups.find(g=>String(g.id)===String(ctx().groupId)); }
function draftPresent() { return !!document.querySelector('#send_textarea')?.value.trim(); }
function requireActiveSetup() {
    if(!groupSettings().active) throw new Error('Enable active routing for this group first.');
    if(Number(currentGroup()?.activation_strategy)!==group_activation_strategy.MANUAL) throw new Error('Set this group’s reply order to Manual before using active routing.');
    if(is_group_automode_enabled) throw new Error('Turn off SillyTavern Auto-mode before using active routing.');
}
function displayDecision(payload,result,dryRun) {
    const name=id=>payload.participants.find(p=>p.id===id)?.name || id;
    const output=root.querySelector('[data-result]'); output.replaceChildren();
    output.append(element('p',result.selected==='USER'?`Waiting for ${name('USER')}.`:`${dryRun?'Would select':'Selected'} ${name(result.selected)}.${dryRun?' No response generated.':''}`));
    const table=element('table'); table.style.width='100%';
    for(const p of payload.participants) {
        const row=element('tr'); row.append(element('td',`${p.name} (${p.id})`));
        if (Object.hasOwn(result.probabilities,p.id)) {
            const raw = `${(result.probabilities[p.id]*100).toFixed(1)}%`;
            const bonus = result.bonuses && Object.hasOwn(result.bonuses,p.id) ? result.bonuses[p.id] : 0;
            const adjusted = result.adjustedProbabilities && Object.hasOwn(result.adjustedProbabilities,p.id) ? `${(result.adjustedProbabilities[p.id]*100).toFixed(1)}%` : null;
            row.append(element('td', adjusted && bonus ? `${raw} (+${(bonus*100).toFixed(1)}% bonus) = ${adjusted}` : raw));
        } else {
            row.append(element('td',p.id===payload.last_speaker?'Excluded: previous speaker':'Excluded for Continue'));
        }
        table.append(row);
    }
    output.append(table,element('p',`${result.model} · ${result.elapsedMs} ms`));
    const details=element('details'); details.append(element('summary','Request context and result'));
    const pre=element('pre',JSON.stringify({state:payload,result},null,2));
    pre.style.cssText='white-space:pre-wrap;max-height:400px;overflow:auto'; details.append(pre); output.append(details);
}
async function evaluate(dryRun=true, continueOther=false) {
    if(running) {status('A routing operation is still finishing.');return;}
    if(isGenerating()) throw new Error('Wait for the current response to finish.');
    if(draftPresent()) throw new Error('Send or clear your draft before routing.');
    if(!dryRun) requireActiveSetup();
    cancel();
    const epoch=revision, ownController=new AbortController(); controller=ownController;
    running=true;trace(`Run started: ${dryRun?'evaluate only':'active'}, limit=${groupSettings().maxResponses}`);
    const adapter={
        async capture(turn) {
            if(isGenerating() || draftPresent()) throw new Error('Routing paused: generation or a draft is in progress.');
            if(!dryRun) requireActiveSetup();
            status('Preparing routing context…');
            const payload=await prepare();
            // An explicit Continue starts a fresh bounded exchange; ordinary
            // routing and Evaluate only use the existing exchange in the chat.
            if(continueOther) payload.response_pacing={...payload.response_pacing,
                completed_responses:turn,counting_from:'explicit_continue'};
            if(payload.participants.length<2) throw new Error('No available unmuted character.');
            // Resolve opaque request IDs to avatar identity once, never to display names.
            const available=currentGroup().members.filter(a=>!(currentGroup().disabled_members||[]).includes(a) && ctx().characters.some(c=>c.avatar===a));
            const avatars=new Map(available.map((a,i)=>[`C${i+1}`,a]));
            const routing=continueOther && turn===0 ? continueOverride(ctx().chat,ctx().characters,avatars) : null;
            trace(`No-repeat: exclude ${payload.last_speaker || 'no current member'}`);
            if(routing) trace(`Continue override: exclude USER and ${routing.excluded_id || 'no current member'}`);
            return {payload, fingerprint:signature(), avatars, routing};
        },
        async decide(snapshot,signal) {
            status('Asking the decision model…');
            const result=await api('/decide',{state:snapshot.payload,model:settings().model,routing:snapshot.routing,gapBonus:Number(groupSettings().gapBonus ?? DEFAULTS.gapBonus) || 0},signal);if(result.selected===snapshot.payload.last_speaker) throw new Error('Router returned the previous speaker. Check that both router components were upgraded.');if(snapshot.routing && (result.selected==='USER' || result.selected===snapshot.routing.excluded_id)) throw new Error('Continue returned an excluded speaker. Check that both router components were upgraded.');trace(`Router chose ${result.selected}`);return result;
        },
        isCurrent(snapshot) {return epoch===revision && snapshot.fingerprint===signature() && !isGenerating() && !draftPresent();},
        display(snapshot,result,preview) {displayDecision(snapshot.payload,result,preview);},
        async generate(snapshot,selected) {
            requireActiveSetup();
            if(!adapter.isCurrent(snapshot)) throw new Error('Decision discarded because the conversation changed.');
            const avatar=snapshot.avatars.get(selected), group=currentGroup();
            const index=ctx().characters.findIndex(c=>c.avatar===avatar);
            if(!avatar || index<0 || !group.members.includes(avatar) || group.disabled_members?.includes(avatar)) throw new Error('Selected character is no longer available.');
            const chat=ctx().chat, start=chat.length;
            const generation=new AbortController(); ownedGeneration=generation;
            setExternalAbortController(generation);
            status(`Generating ${ctx().characters[index].name}…`);
            try {
                const result=await generateGroupWrapper(true,'normal',{force_chid:index,signal:generation.signal});
                if(ownController.signal.aborted || generation.signal.aborted) return;
                const message=chat.at(-1);trace(`Generation returned: newMessages=${chat.length-start}, hasText=${!!message?.mes?.trim()}, hasResult=${!!result}, speakerMatches=${message?.original_avatar===avatar}`);
                if(ctx().chat!==chat || chat.length<=start || message?.is_user || message?.is_system || message?.original_avatar!==avatar || !message?.mes?.trim() || !result || !String(result).trim()) throw new Error('No complete character response was produced. Routing stopped.');
            } finally {if(ownedGeneration===generation) ownedGeneration=null;}
        },
    };
    try {
        const outcome=await runTurns(adapter,{dryRun,limit:groupSettings().maxResponses,signal:ownController.signal});
        if(epoch!==revision) {trace(`Run ended after cancellation: ${outcome.reason}, completed=${outcome.count}`);return;}
        const messages={'dry-run':'Dry run complete.',user:'Waiting for you.',limit:`Response limit reached (${outcome.count}). Waiting for you.`,changed:'Conversation changed; decision discarded.',stopped:'Stopped.'};
        status(messages[outcome.reason]);
    } catch(e) {trace(`Run error: ${e?.message || 'unknown error'}`);if(epoch===revision)status(ownController.signal.aborted?'Stopped.':e.message);}
    finally {if(controller===ownController)controller=null;running=false;}
}
function schedule(kind='user') {
    if(!root || !ctx().groupId) return;
    const options=groupSettings();
    if(options.active ? kind!=='user' : !options.auto) return;
    trace(`Automatic routing queued: ${kind}`);
    cancel(undefined,false);
    const epoch=revision, start=Date.now();
    function check() {
        if(epoch!==revision) return;
        timer=null;
        if(Date.now()-start>120000) {status('Routing wait expired. Use Route now.');return;}
        if(isGenerating() || running) {timer=setTimeout(check,200);return;}
        evaluate(!groupSettings().active).catch(e=>status(e.message));
    }
    timer=setTimeout(check,200);
}
function render() {
    if(!root) return;
    root.replaceChildren();
    const drawer=element('div');drawer.className='inline-drawer';
    const header=element('div');header.className='inline-drawer-toggle inline-drawer-header';
    header.append(element('b','Jev Speaker Router'));
    const icon=element('div');icon.className=`inline-drawer-icon fa-solid fa-circle-chevron-${drawerOpen?'up':'down'} ${drawerOpen?'up':'down'}`;header.append(icon);
    const details=element('div');details.className='inline-drawer-content';details.style.display=drawerOpen?'block':'none';
    header.addEventListener('click',()=>{drawerOpen=!drawerOpen;});
    drawer.append(header,details);root.append(drawer);
    details.append(element('small','Version 0.5.2'));
    details.append(element('p','Preview decisions or enable active routing for this group. Routing sends the previewed context to OpenRouter.'));
    const controls=element('div'); controls.style.cssText='display:flex;gap:6px;flex-wrap:wrap';
    controls.append(button('Check connection',async()=>{
        const data=await api('/status'); status(data.credentialConfigured?'Plugin connected; active OpenRouter key found.':'Plugin connected; save an OpenRouter key in API Connections.');
    }),button('Preview context',async()=>{
        const data=await prepare(); root.querySelector('[data-result]').textContent=JSON.stringify(data,null,2); status('Preview only; no request sent.');
    }),button('Evaluate only',()=>evaluate(true)),button('Route now',()=>evaluate(false)),button('Continue with someone else',()=>evaluate(false,true)),button('Stop routing',()=>cancel('Stopped.')));
    details.append(controls);
    const s=settings();
    const model=element('input');model.className='text_pole';model.value=s.model;
    const knownModels=element('datalist');knownModels.id='speaker-router-models';
    for(const known of ['typesafe/jev-1.13','~typesafe/jev-latest','perplexity/pplx-decider-v1.1-27b']){const option=element('option');option.value=known;knownModels.append(option);}
    model.setAttribute('list','speaker-router-models');
    model.addEventListener('change',()=>{cancel();s.model=model.value.trim();save();});
    details.append(element('label','Decision model'),model,knownModels);
    if(ctx().groupId) {
        const g=groupSettings();
        const activeLabel=element('label');activeLabel.className='checkbox_label';
        const active=element('input');active.type='checkbox';active.checked=!!g.active;
        active.addEventListener('change',()=>{cancel('Routing settings changed.');g.active=active.checked;save();render();});
        activeLabel.append(active,element('span','Enable active routing for this group'));details.append(activeLabel);
        details.append(element('p','Active mode requires Manual reply order, Auto-mode off, and other speaker routers disabled. Enabling it waits for your next message or Route now.'));
        const label=element('label'); const auto=element('input');auto.type='checkbox';auto.checked=g.auto;auto.disabled=!!g.active;label.className='checkbox_label';
        auto.addEventListener('change',()=>{cancel();g.auto=auto.checked;save();});
        label.append(auto,document.createTextNode(' Automatically evaluate in dry-run mode'));details.append(label);
        for(const [key,title,min,max] of [['history','Recent messages',4,50],['maxResponses','Maximum character responses per turn',1,10]]) {
            const input=element('input');input.type='number';input.min=min;input.max=max;input.value=g[key];input.className='text_pole';
            input.addEventListener('change',()=>{cancel();g[key]=Math.max(min,Math.min(max,Number(input.value)||DEFAULTS[key]));input.value=g[key];save();});
            details.append(element('label',title),input);
        }
        // Silence bonus (gap bonus) slider: 0 = off, 100 = strongest.
        // Capped in the plugin, so it nudges overlooked present characters
        // without forcing a rotation. Shown live in Evaluate only results.
        {
            const gapLabel=element('label',`Silence bonus (gap bonus): ${g.gapBonus ?? DEFAULTS.gapBonus}`);
            const gap=element('input');gap.type='range';gap.min=0;gap.max=100;gap.step=5;gap.value=g.gapBonus ?? DEFAULTS.gapBonus;gap.className='text_pole';
            gap.addEventListener('input',()=>{g.gapBonus=Number(gap.value);gapLabel.textContent=`Silence bonus (gap bonus): ${g.gapBonus}`;save();});
            gap.addEventListener('change',()=>{cancel();save();});
            details.append(gapLabel,gap);
        }
        const group=ctx().groups.find(x=>String(x.id)===String(ctx().groupId));
        for(const avatar of group?.members || []) {
            const c=ctx().characters.find(c=>c.avatar===avatar);if(!c)continue;
            const field=element('textarea');field.className='text_pole';field.rows=3;field.maxLength=1800;field.value=s.profiles[avatar]||'';
            field.placeholder='Optional: relationship and conversational role. Blank uses character description/personality.';
            field.addEventListener('input',()=>{cancel();s.profiles[avatar]=field.value;save();});
            details.append(element('label',`${c.name} — ${avatar}${group.disabled_members?.includes(avatar)?' (muted)':''}`),field);
        }
    } else details.append(element('p','Open a group chat to edit its settings and profiles.'));
    const statusBox=element('p',lastStatus);statusBox.dataset.status='';details.append(statusBox);
    const result=element('div');result.dataset.result='';result.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:600px;overflow:auto';details.append(result);
    const diagnostics=element('details');diagnostics.append(element('summary','Routing diagnostics (last 100 events)'));
    const log=element('textarea');log.dataset.diagnostics='';log.className='text_pole';log.rows=12;log.readOnly=true;log.value=activity.join('\n');diagnostics.append(log);details.append(diagnostics);
    // Standard SillyTavern inline drawer handles expansion.
}
// Cast row (0.5.0, resized in 0.5.1 and 0.5.2): a small, in-flow row of avatar bubbles inserted
// immediately before #chat (after #sheldheader when present), so it sits
// below the top menu (#top-bar) and above the messages, without fixed
// positioning fighting a collapsing top menu. Tap toggles SillyTavern's
// existing mute (group.disabled_members) via editGroup, exactly as the
// native group-menu button does; the router already excludes muted
// characters, so no new cast state is needed. Re-rendered only on group /
// chat change, never per message, to keep the mobile UI light.
function avatarUrl(avatar) {
    try { if (typeof getThumbnailUrl === 'function') return getThumbnailUrl('avatar', avatar); } catch {}
    return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
}
function adjustCastChatHeight(chatEl) {
    // 0.5.1: #sheld has a fixed height and #chat's own max-height in
    // SillyTavern's CSS does not account for a row inserted before it, so
    // the row's height would otherwise push #sheld past its height and let
    // it scroll/clip the row. Shrink #chat by the row's measured height so
    // the total fits and #chat scrolls internally as before. Restored when
    // the row is removed. Guarded for the simulated-DOM tests, where
    // offsetHeight is undefined.
    try {
        const h = castRoot?.offsetHeight;
        if (h && chatEl?.style) {
            chatEl.style.minHeight = '0';
            chatEl.style.maxHeight = `calc(100dvh - var(--topBarBlockSize, 0px) - var(--bottomFormBlockSize, 0px) - ${h}px)`;
        }
    } catch {}
}
function renderCast() {
    const group = currentGroup();
    const chatEl = document.querySelector('#chat');
    if (!group || !chatEl || !chatEl.parentNode) {
        try { if (chatEl?.style) { chatEl.style.maxHeight = ''; chatEl.style.minHeight = ''; } } catch {}
        castRoot?.remove(); castRoot = null; return;
    }
    if (!castRoot || !castRoot.isConnected) {
        castRoot = element('div'); castRoot.id = 'jev-speaker-router-cast';
        // 0.5.1: taller, non-clipping row. flex:0 0 auto stops a flex parent
        // squeezing it, and a min-height plus visible vertical overflow stop
        // the bubbles being chopped at top/bottom.
        // 0.5.2: background is transparent, never a theme colour. 0.5.1 set
        // it to var(--SmartThemeBodyColor), which rendered as a light grey
        // bar on a dark/custom theme. Transparent lets #sheld's own dark
        // background show through, so the row follows the user's theme.
        // Size is also pulled back from 0.5.1: 32px avatars, 40px targets,
        // 46px row, between 0.5.0's 28/32 and 0.5.1's 36/44/56.
        castRoot.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 8px;overflow-x:auto;overflow-y:visible;flex-wrap:nowrap;flex:0 0 auto;min-height:46px;box-sizing:border-box;position:relative;z-index:5;background:transparent;';
        chatEl.parentNode.insertBefore(castRoot, chatEl);
    }
    castRoot.replaceChildren();
    if (castCollapsed) {
        const expand = element('button'); expand.type = 'button'; expand.textContent = 'Cast ▾'; expand.className = 'menu_button';
        expand.style.cssText = 'flex:0 0 auto;white-space:nowrap;min-width:72px;padding:6px 10px;box-sizing:border-box;';
        expand.addEventListener('click', () => { castCollapsed = false; renderCast(); });
        castRoot.append(expand); adjustCastChatHeight(chatEl); return;
    }
    for (const avatar of group.members || []) {
        const c = ctx().characters.find(x => x.avatar === avatar); if (!c) continue;
        const muted = (group.disabled_members || []).includes(avatar);
        const btn = element('button'); btn.type = 'button';
        btn.title = `${c.name}: ${muted ? 'muted, tap to unmute' : 'in cast, tap to mute'}`;
        btn.setAttribute('aria-label', btn.title); btn.setAttribute('aria-pressed', String(!muted));
        // 0.5.2: 32px avatar + 4px padding = 40px tap target, between
        // 0.5.0's 32px and 0.5.1's 44px. Text buttons stay at 36px high.
        btn.style.cssText = 'flex:0 0 auto;width:40px;height:40px;display:flex;align-items:center;justify-content:center;padding:4px;border:1px solid transparent;border-radius:50%;background:transparent;cursor:pointer;box-sizing:border-box;';
        const img = element('img'); img.src = avatarUrl(avatar); img.alt = c.name;
        img.style.cssText = `width:32px;height:32px;flex:0 0 auto;border-radius:50%;object-fit:cover;display:block;${muted ? 'filter:grayscale(1);opacity:0.45;' : ''}`;
        img.addEventListener('error', () => { img.style.display = 'none'; });
        btn.append(img);
        btn.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await toggleCast(avatar); });
        castRoot.append(btn);
    }
    // 0.5.1: text buttons must not wrap or shrink. SillyTavern's menu_button
    // can be narrow in a flex row, which wrapped "All on" out of view.
    const all = element('button'); all.type = 'button'; all.textContent = 'All on'; all.className = 'menu_button';
    all.style.cssText = 'flex:0 0 auto;white-space:nowrap;min-width:72px;padding:6px 10px;height:36px;box-sizing:border-box;line-height:1.2;';
    all.addEventListener('click', async (e) => { e.preventDefault(); await unmuteAllCast(); });
    const hide = element('button'); hide.type = 'button'; hide.textContent = 'Hide'; hide.className = 'menu_button';
    hide.style.cssText = 'flex:0 0 auto;white-space:nowrap;min-width:64px;padding:6px 10px;height:36px;box-sizing:border-box;line-height:1.2;';
    hide.addEventListener('click', () => { castCollapsed = true; renderCast(); });
    castRoot.append(all, hide);
    adjustCastChatHeight(chatEl);
}
async function toggleCast(avatar) {
    if (castToggling) return; castToggling = true;
    const group = currentGroup();
    if (!group) { castToggling = false; return; }
    group.disabled_members ??= [];
    const idx = group.disabled_members.indexOf(avatar);
    const wasMuted = idx >= 0;
    if (wasMuted) group.disabled_members.splice(idx, 1); else group.disabled_members.push(avatar);
    try {
        if (typeof editGroup !== 'function') throw new Error('editGroup is unavailable in this SillyTavern version.');
        await editGroup(group.id, false, false);
    } catch (e) {
        if (wasMuted) { if (!group.disabled_members.includes(avatar)) group.disabled_members.push(avatar); }
        else { const j = group.disabled_members.indexOf(avatar); if (j >= 0) group.disabled_members.splice(j, 1); }
        status(`Cast toggle failed: ${e.message}`); castToggling = false; return;
    }
    try {
        if (event_types.GROUP_UPDATED) await eventSource.emit(event_types.GROUP_UPDATED);
        else renderCast();
    } finally { castToggling = false; }
    trace(`Cast toggle: ${avatar} ${wasMuted ? 'unmuted' : 'muted'}`);
}
async function unmuteAllCast() {
    if (castToggling) return; castToggling = true;
    const group = currentGroup();
    if (!group || !(group.disabled_members || []).length) { castToggling = false; return; }
    const previous = [...group.disabled_members];
    group.disabled_members.length = 0;
    try {
        if (typeof editGroup !== 'function') throw new Error('editGroup is unavailable in this SillyTavern version.');
        await editGroup(group.id, false, false);
        if (event_types.GROUP_UPDATED) await eventSource.emit(event_types.GROUP_UPDATED); else renderCast();
    } catch (e) {
        group.disabled_members.push(...previous);
        status(`Cast toggle failed: ${e.message}`);
    } finally { castToggling = false; }
}
function boot() {
    if(root) return;
    const target=document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if(!target) return;
    root=element('div');root.id='jev-speaker-router';target.append(root);render();renderCast();
    document.addEventListener('click',(event)=>{
        const control=event.target?.closest?.('#mes_continue, #option_continue, #send_but');
        if(!control || !ctx().groupId || !shouldOverrideContinue(control.id,!!groupSettings().active,draftPresent(),event.isTrusted)) return;
        // Capture before ST's target/delegated click handlers. Its internal jQuery
        // auto-continuations do not pass through this native user-click hook.
        event.preventDefault();event.stopImmediatePropagation();
        if(document.querySelector('.mes.editing, .mes .edit_textarea')) {status('Finish editing the message before continuing.');return;}
        evaluate(false,true).catch(e=>status(e.message));
    },true);
    if(event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT,(id)=>{
        const chat=ctx().chat;
        if(id===chat.length-1 && chat[id]?.is_user && !chat[id]?.is_system) schedule('user');
    });
    if(event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED,()=>{
        if(!running && !groupSettings().active) schedule('character');
    });
    for(const name of ['CHAT_CHANGED','GROUP_UPDATED','CHARACTER_EDITED','CHARACTER_DELETED','CHARACTER_DUPLICATED']) if(event_types[name]) eventSource.on(event_types[name],()=>{cancel(`Routing cancelled by ${name}.`);render();renderCast();});
    for(const name of ['MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STOPPED']) if(event_types[name]) eventSource.on(event_types[name],()=>cancel(`Routing cancelled by ${name}.`));
    if(event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED,(type,params,dryRun)=>{
        trace(`GENERATION_STARTED type=${type}; dryRun=${!!dryRun}; owned=${!!ownedGeneration && params?.signal===ownedGeneration.signal}`);
        if(dryRun===true) {trace('Ignored prompt-building dry run.');return;}
        if(ownedGeneration && params?.signal===ownedGeneration.signal) return;
        cancel(`External generation started (${type || 'normal'}); routing paused.`,false);
    });
    document.querySelector('#send_textarea')?.addEventListener('input',(event)=>{
        if(event?.isTrusted===false) return;
        if(draftPresent() && (running||timer)) cancel('Paused while you compose a message.',false);
    });
}
if(event_types.APP_READY) eventSource.on(event_types.APP_READY,boot);
$(boot);
