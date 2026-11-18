export const DEFAULTS = { history: 20, maxResponses: 3, auto: false, active: false, gapBonus: 33 };
const clip = (v,n) => String(v ?? '').slice(0,n);
export function buildState(ctx, settings, substitute = s => s) {
    const group = ctx.groups.find(g => String(g.id) === String(ctx.groupId));
    if (!group) throw new Error('Open a group chat first.');
    const options = {...DEFAULTS, ...settings.groups?.[String(group.id)]};
    const members = group.members.filter(a => !(group.disabled_members || []).includes(a));
    if (members.length > 24) throw new Error('This prototype supports up to 24 unmuted characters.');
    const participants = [{id:'USER', name:clip(ctx.name1 || 'User',160), type:'user'}];
    const identities = new Map();
    const backgrounds = [];
    for (const avatar of members) {
        const c = ctx.characters.find(c => c.avatar === avatar);
        if (!c) continue;
        const id = `C${participants.length}`;
        identities.set(avatar,id);
        const profile = settings.profiles?.[avatar];
        participants.push({id, name:clip(c.name,160), type:'character',
            routing_profile:clip(substitute(profile || [c.description || c.data?.description,c.personality || c.data?.personality].filter(Boolean).join('\n'), c.name),1800)});
        if (!ctx.chatMetadata?.scenario) backgrounds.push({character:id, scenario:clip(substitute(c.scenario || c.data?.scenario || '',c.name),600)});
    }
    // Count the actual exchange independently of the truncated context window.
    let responsesSinceUser = 0;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m.is_system || m.extra?.isSmallSys || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        if (m.is_user) break;
        responsesSinceUser++;
    }
    let budget = 18000;
    const messages = [];
    const recent = ctx.chat.filter(m => !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string' && m.mes.trim()).slice(-Math.max(4,Math.min(50,Number(options.history)||20)));
    for (const m of recent.reverse()) {
        if (budget <= 0) break;
        const max = Math.min(3000,budget);
        const raw = String(m.mes);
        const text = raw.length > max ? (raw.slice(0,Math.max(0,max-20))+' [message truncated]').slice(0,max) : raw;
        budget -= text.length;
        messages.unshift({speaker_id:m.is_user?'USER':identities.get(m.original_avatar)||null,
            speaker_name:clip(m.name,160), text});
    }
    // Resolve the latest actual speaker by avatar, with a conservative legacy fallback.
    const last = recent[0]; // recent was reversed above: newest first
    if (last && !last.is_user && !last.original_avatar) {
        const matches = ctx.characters.filter(c => c.name === last.name);
        if (matches.length > 1) throw new Error('Cannot identify the last character unambiguously. Select a speaker manually.');
        messages.at(-1).speaker_id = identities.get(matches[0]?.avatar) || null;
    }
    // Gap: character turns since each participant last spoke, counted over the
    // full chat (not the truncated window, and not reset by user messages).
    // System notes and empty placeholders do not count. A participant who has
    // never spoken gets the total character-turn count, so the bonus saturates
    // at its cap rather than growing without bound.
    {
        const gaps = new Map();
        const seen = new Set();
        let turns = 0;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (!m || m.is_system || m.extra?.isSmallSys || typeof m.mes !== 'string' || !m.mes.trim() || m.is_user) continue;
            let id = identities.get(m.original_avatar);
            if (!id && m.original_avatar === undefined && m.name) {
                const matches = ctx.characters.filter(c => c.name === m.name);
                if (matches.length === 1) id = identities.get(matches[0].avatar);
            }
            if (id && !seen.has(id)) { gaps.set(id, turns); seen.add(id); }
            turns++;
        }
        for (const p of participants) {
            p.turns_since_last_spoke = p.id === 'USER' ? null : (gaps.has(p.id) ? gaps.get(p.id) : turns);
        }
    }
    return {participants, background_scenario:clip(substitute(ctx.chatMetadata?.scenario || ''),2000),
        character_starting_scenarios:backgrounds, recent_messages:messages,
        last_speaker:messages.at(-1)?.speaker_id || null,
        response_pacing:{completed_responses:responsesSinceUser, preferred_responses:2,
            maximum_responses:Math.max(1,Math.min(10,Number(options.maxResponses)||3)),
            counting_from:'latest_user_message'},
        context_note:'Background scenarios may be outdated. Recent scene evidence takes precedence. History and profiles may be truncated.'};
}

// SillyTavern 1.19 uses an options object. Passing undefined as argument 2
// activates the default object, so an old third-argument character name is lost.
export function substituteForParticipant(substitute, text, name) {
    return substitute(text, name === undefined ? {} : { name2Override: name });
}

export function continueOverride(chat, characters, avatars) {
    const last = [...chat].reverse().find(m => !m.is_user && !m.is_system && !m.extra?.isSmallSys && typeof m.mes === 'string' && m.mes.trim());
    let avatar = last?.original_avatar;
    if (last && !avatar) {
        const matches = characters.filter(c => c.name === last.name);
        if (matches.length > 1) throw new Error('Cannot identify the last character unambiguously. Select a speaker manually.');
        avatar = matches[0]?.avatar;
    }
    const excludedId = [...avatars].find(([,a]) => a === avatar)?.[0] || null;
    const eligible = [...avatars.keys()].filter(id => id !== excludedId);
    if (!eligible.length) throw new Error('No other available character.');
    return { mode:'continue_other', excluded_id:excludedId };
}
export function shouldOverrideContinue(controlId, active, hasDraft, trusted = true) {
    return active && trusted && (['mes_continue','option_continue'].includes(controlId) || (controlId === 'send_but' && !hasDraft));
}
