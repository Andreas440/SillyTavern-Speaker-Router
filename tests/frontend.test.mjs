import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildState,DEFAULTS,substituteForParticipant,continueOverride,shouldOverrideContinue} from '../extensions/jev-speaker-router/context.js';
import {runTurns} from '../extensions/jev-speaker-router/runner.js';
const source=(await readFile(new URL('../extensions/jev-speaker-router/index.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.value='';this.textContent='';this.listeners={};this.attributes={};}
 setAttribute(name,value){this.attributes[name]=value;}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 addEventListener(name,fn){this.listeners[name]=fn;}
 querySelector(q){const key=q.slice(6,-1);return this.walk().find(x=>Object.hasOwn(x.dataset,key));}
 walk(){return [this,...this.children.flatMap(c=>c.walk?c.walk():[])];}
}
function fixture({choices=['C1','C2','C1'], mutateDuringDecision, duringGeneration, delay=0}={}){
 const domHandlers={};const requests=[];const target=new Element('div'),draft=new Element('textarea');let busy=false,generated=0,decisions=0,abort;
 const ctx={groupId:1,chatId:'test',name1:'Dre',chatMetadata:{},chat:[{name:'Dre',is_user:true,mes:'Hi'}],characters:[{name:'Someone new',avatar:'new.png',description:'{{char}} is here'},{name:'Second',avatar:'second.png'}],groups:[{id:1,members:['new.png','second.png'],disabled_members:[],activation_strategy:2}],extensionSettings:{},saveSettingsDebounced:()=>{},getRequestHeaders:()=>({})};
 const handlers={};const events={on:(name,fn)=>(handlers[name]??=[]).push(fn),emit:async(name,...args)=>{for(const fn of handlers[name]||[])await fn(...args);}};
 const eventNames=['APP_READY','MESSAGE_SENT','CHARACTER_MESSAGE_RENDERED','CHAT_CHANGED','GROUP_UPDATED','CHARACTER_EDITED','CHARACTER_DELETED','CHARACTER_DUPLICATED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STOPPED','GENERATION_STARTED'];
 const deps={buildState,DEFAULTS,substituteForParticipant,continueOverride,shouldOverrideContinue,runTurns,eventSource:events,event_types:Object.fromEntries(eventNames.map(x=>[x,x])),isGenerating:()=>busy,unshallowCharacter:async()=>{},substituteParams:(text,options={})=>text.replaceAll('{{char}}',options.name2Override||''),setExternalAbortController:c=>abort=c,stopGeneration:()=>{abort?.abort();events.emit('GENERATION_STOPPED');},is_group_automode_enabled:false,group_activation_strategy:{MANUAL:2},SillyTavern:{getContext:()=>ctx},$:fn=>fn(),document:{addEventListener:(event,fn)=>domHandlers[event]=fn,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),querySelector:q=>q.startsWith('.mes')?null:q==='#send_textarea'?draft:target},fetch:async(_url,options)=>{
  decisions++;const body=JSON.parse(options.body);requests.push(body);assert.equal(body.state.participants[1].routing_profile,'Someone new is here');
  mutateDuringDecision?.(ctx);if(delay)await new Promise(r=>setTimeout(r,delay));
  const selected=choices.shift()||'USER';return {ok:true,json:async()=>({selected,probabilities:{USER:selected==='USER'?1:0,C1:selected==='C1'?1:0}})};
 },generateGroupWrapper:async(auto,_type,params)=>{
  assert.equal(auto,true);busy=true;await events.emit('GENERATION_STARTED','normal',{signal:params.signal});
  if(params.signal.aborted){busy=false;return;}
  await duringGeneration?.(events,ctx);
  generated++;const character=ctx.characters[params.force_chid];ctx.chat.push({name:character.name,original_avatar:character.avatar,mes:'Response',is_user:false});await events.emit('CHARACTER_MESSAGE_RENDERED');busy=false;return new String('Response');
 }};
 const app=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;\n${source}\nreturn {evaluate,settings,render,cancel};`)(deps);
 return {app,ctx,target,draft,events,requests,domHandlers,generated:()=>generated,decisions:()=>decisions,status:()=>target.querySelector('[data-status]').textContent};
}
test('frontend creates standard drawer and fixes per-character macros',async()=>{const f=fixture();const drawer=f.target.children[0].children[0];assert.equal(drawer.className,'inline-drawer');assert.equal(drawer.children[0].className,'inline-drawer-toggle inline-drawer-header');await f.app.evaluate(true);assert.equal(f.generated(),0);assert.equal(f.status(),'Dry run complete.');});

test('cast row is shown by default and the settings checkbox hides it',async()=>{
    const f=fixture();
    assert.equal(f.app.settings().showCast,true);
    // The drawer is only built once the extension boots; render() builds it here.
    f.app.render();
    const all=f.target.walk();
    const label=all.find(x=>x.tag==='span' && x.textContent==='Show cast row in group chats');
    assert.ok(label,'settings checkbox label is present');
    const row=all.find(x=>x.tag==='label' && x.children?.includes(label));
    const box=row.children.find(x=>x.tag==='input');
    assert.equal(box.checked,true);
    box.checked=false; box.listeners.change();
    assert.equal(f.app.settings().showCast,false);
    box.checked=true; box.listeners.change();
    assert.equal(f.app.settings().showCast,true);
});

test('public hook toggles cast visibility',async()=>{
    const f=fixture();
    const hook=globalThis.JevSpeakerRouter;
    assert.equal(typeof hook.setCastVisible,'function');
    assert.equal(typeof hook.isCastVisible,'function');
    assert.equal(hook.isCastVisible(),true);
    hook.setCastVisible(false);
    assert.equal(f.app.settings().showCast,false);
    assert.equal(hook.isCastVisible(),false);
    hook.setCastVisible(true);
    assert.equal(hook.isCastVisible(),true);
});
test('frontend active mode awaits its own generations and caps at three',async()=>{const f=fixture();f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),3);assert.equal(f.decisions(),3);assert.match(f.status(),/Response limit reached/);});
test('frontend USER yields with no generation',async()=>{const f=fixture({choices:['USER']});f.ctx.chat.push({original_avatar:'new.png',mes:'Reply'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),0);assert.equal(f.status(),'Waiting for you.');});
test('frontend rejects stale mute change while Jev runs',async()=>{const f=fixture({mutateDuringDecision:c=>c.groups[0].disabled_members.push('new.png')});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),0);assert.match(f.status(),/discarded/);});
test('frontend blocks active routing in nonmanual mode',async()=>{const f=fixture();f.app.settings().groups['1'].active=true;f.ctx.groups[0].activation_strategy=0;await assert.rejects(f.app.evaluate(false),/Manual/);assert.equal(f.decisions(),0);});
test('frontend cancels delayed decision when user types',async()=>{const f=fixture({delay:30});f.app.settings().groups['1'].active=true;const pending=f.app.evaluate(false);await new Promise(r=>setTimeout(r,5));f.draft.value='typing';f.draft.listeners.input();await pending;assert.equal(f.generated(),0);assert.match(f.status(),/Paused/);});
test('frontend defers user message routing until manual send finishes',async()=>{const f=fixture({choices:['C1','USER']});f.app.settings().groups['1'].active=true;f.ctx.chat.push({is_user:true,mes:'Next'});await f.events.emit('MESSAGE_SENT',f.ctx.chat.length-1);await new Promise(r=>setTimeout(r,260));assert.equal(f.decisions(),2);assert.equal(f.generated(),1);assert.equal(f.status(),'Waiting for you.');});

test('background prompt dry run during character generation does not cancel loop',async()=>{const f=fixture({duringGeneration:async events=>events.emit('GENERATION_STARTED','normal',{},true)});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),3);assert.match(f.status(),/Response limit reached/);});
test('memory-only metadata writes during routing do not stale a decision',async()=>{const f=fixture({mutateDuringDecision:c=>{c.chatMetadata.qvink={updated:Date.now()};c.chat[0].extra={memory:'summary'};}});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),3);});
test('actual message edit during routing still invalidates decision',async()=>{const f=fixture({mutateDuringDecision:c=>c.chat[0].mes='Changed'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),0);assert.match(f.status(),/discarded/);});
test('queued user turn survives prompt-building event',async()=>{const f=fixture({choices:['C1','USER']});f.app.settings().groups['1'].active=true;f.ctx.chat.push({is_user:true,mes:'Next'});await f.events.emit('MESSAGE_SENT',f.ctx.chat.length-1);await f.events.emit('GENERATION_STARTED','normal',{},true);await new Promise(r=>setTimeout(r,260));assert.equal(f.decisions(),2);assert.equal(f.generated(),1);assert.equal(f.status(),'Waiting for you.');});
test('actual external generation still cancels queued turn',async()=>{const f=fixture();f.app.settings().groups['1'].active=true;f.ctx.chat.push({is_user:true,mes:'Next'});await f.events.emit('MESSAGE_SENT',f.ctx.chat.length-1);await f.events.emit('GENERATION_STARTED','normal',{},false);await new Promise(r=>setTimeout(r,260));assert.equal(f.decisions(),0);});

test('Continue excludes last speaker once, then restores normal candidate request',async()=>{const f=fixture({choices:['C3','USER']});f.ctx.characters.push({name:'Another',avatar:'other.png'});f.ctx.groups[0].members.push('other.png');f.ctx.chat.push({name:'Someone new',original_avatar:'new.png',mes:'Latest response'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false,true);assert.equal(f.generated(),1);assert.deepEqual(f.requests[0].routing,{mode:'continue_other',excluded_id:'C1'});assert.equal(f.requests[1].routing,null);assert.equal(f.ctx.chat.at(-1).original_avatar,'other.png');});
test('Continue with no alternative makes no API request',async()=>{const f=fixture();f.ctx.groups[0].members=['new.png'];f.ctx.chat.push({name:'Someone new',original_avatar:'new.png',mes:'Latest response'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false,true);assert.equal(f.decisions(),0);assert.equal(f.generated(),0);assert.equal(f.status(),'No other available character.');});
test('Continue refuses an excluded speaker from an old backend',async()=>{const f=fixture({choices:['C1']});f.ctx.characters.push({name:'Another',avatar:'other.png'});f.ctx.groups[0].members.push('other.png');f.ctx.chat.push({name:'Someone new',original_avatar:'new.png',mes:'Latest'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false,true);assert.equal(f.generated(),0);assert.match(f.status(),/previous speaker|excluded speaker/);});

test('native Continue click is intercepted and uses restricted first request',async()=>{const f=fixture({choices:['C3','USER']});f.ctx.characters.push({name:'Another',avatar:'other.png'});f.ctx.groups[0].members.push('other.png');f.ctx.chat.push({original_avatar:'new.png',mes:'Latest'});f.app.settings().groups['1'].active=true;let prevented=false,stopped=false;f.domHandlers.click({isTrusted:true,target:{closest:()=>({id:'mes_continue'})},preventDefault:()=>prevented=true,stopImmediatePropagation:()=>stopped=true});await new Promise(r=>setTimeout(r,25));assert.ok(prevented && stopped);assert.equal(f.generated(),1);assert.equal(f.requests[0].routing.excluded_id,'C1');});

test('frontend blocks repeated USER from an outdated backend',async()=>{const f=fixture({choices:['USER']});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),0);assert.match(f.status(),/previous speaker/);});
test('frontend blocks repeated character from an outdated backend',async()=>{const f=fixture({choices:['C1','C1']});f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.equal(f.generated(),1);assert.match(f.status(),/previous speaker/);});
test('each chained request captures the newly completed speaker',async()=>{const f=fixture();f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.deepEqual(f.requests.map(r=>r.state.last_speaker),['USER','C1','C2']);assert.equal(f.generated(),3);});

test('active sequence sends increasing completed response counts',async()=>{const f=fixture();f.app.settings().groups['1'].active=true;await f.app.evaluate(false);assert.deepEqual(f.requests.map(r=>r.state.response_pacing.completed_responses),[0,1,2]);assert.equal(f.generated(),3);});
test('Evaluate only uses existing exchange count without generating',async()=>{const f=fixture({choices:['USER']});f.ctx.chat.push({original_avatar:'new.png',mes:'One'},{original_avatar:'second.png',mes:'Two'});await f.app.evaluate(true);assert.equal(f.requests[0].state.response_pacing.completed_responses,2);assert.equal(f.generated(),0);});
test('Continue starts fresh pacing and increments after its first reply',async()=>{const f=fixture({choices:['C2','USER']});f.ctx.chat.push({original_avatar:'second.png',mes:'One'},{original_avatar:'new.png',mes:'Two'});f.app.settings().groups['1'].active=true;await f.app.evaluate(false,true);assert.deepEqual(f.requests.map(r=>r.state.response_pacing.completed_responses),[0,1]);assert.ok(f.requests.every(r=>r.state.response_pacing.counting_from==='explicit_continue'));assert.equal(f.generated(),1);});
test('maximum one remains a hard cap despite preference for two',async()=>{const f=fixture();Object.assign(f.app.settings().groups['1'],{active:true,maxResponses:1});await f.app.evaluate(false);assert.equal(f.generated(),1);assert.equal(f.decisions(),1);assert.equal(f.requests[0].state.response_pacing.maximum_responses,1);});
