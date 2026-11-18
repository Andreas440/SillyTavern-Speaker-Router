import express from 'express';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { makeRequest, parseDecision } from './decision.mjs';
export const info = {id:'jev-speaker-router',name:'Jev Speaker Router',description:'Speaker decisions via OpenRouter.'};
const active = new Set();
export async function init(router) {
    router.use((req,res,next)=> {
        if (!req.user?.directories) return res.status(401).json({error:'Sign in to SillyTavern first.'});
        next();
    });
    router.use(express.json({limit:'120kb'}));
    router.get('/status',(req,res)=>res.json({version:'0.5.2',dryRunOnly:false,credentialConfigured:!!readSecret(req.user.directories,SECRET_KEYS.OPENROUTER)}));
    router.post('/decide',async(req,res)=> {
        let payload;
        try { payload = makeRequest(req.body); }
        catch(e) { return res.status(400).json({error:e.message}); }
        const eligibleIds=Object.keys(payload.questions.next_speaker.criteria);
        if(eligibleIds.length===1) return res.json({selected:eligibleIds[0],apiChoice:null,probabilities:{[eligibleIds[0]]:1},bonuses:{[eligibleIds[0]]:0},adjustedProbabilities:{[eligibleIds[0]]:1},model:'Only eligible speaker (no API call)',confidence:null,usage:null,elapsedMs:0});
        // 0.5.1: exactly one eligible character, even if USER is also eligible
        // (previous speaker null, or a now-muted character). Choosing USER
        // here would just yield with nobody to speak, so pick the character
        // directly with no API call. No-repeat is preserved because the
        // eligible set already excludes the previous speaker.
        const characterIds=eligibleIds.filter(id=>id!=='USER');
        if(characterIds.length===1) {
            const only=characterIds[0];
            return res.json({selected:only,apiChoice:null,probabilities:{[only]:1,USER:0},bonuses:{[only]:0,USER:0},adjustedProbabilities:{[only]:1,USER:0},model:'Only eligible character (no API call)',confidence:null,usage:null,elapsedMs:0});
        }
        const key = readSecret(req.user.directories,SECRET_KEYS.OPENROUTER);
        if (!key) return res.status(400).json({error:'No active OpenRouter key is saved in SillyTavern.'});
        const user = req.user.directories.root || JSON.stringify(req.user.directories);
        if (active.has(user)) return res.status(429).json({error:'A routing request is already in progress. Try again shortly.'});
        active.add(user);
        const controller = new AbortController();
        const timeout = setTimeout(()=>controller.abort(),15000);
        const disconnect = ()=> { if (!res.writableEnded) controller.abort(); };
        res.on('close',disconnect);
        const started = Date.now();
        try {
            // Strip the internal gapBonus before sending upstream: OpenRouter
            // only ever sees {model, state, questions}.
            const upstreamBody = {model:payload.model, state:payload.state, questions:payload.questions};
            const upstream = await fetch('https://openrouter.ai/api/alpha/decisions',{
                method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
                body:JSON.stringify(upstreamBody), signal:controller.signal,
            });
            if (!upstream.ok) {
                await upstream.body?.cancel();
                return res.status(502).json({error:`OpenRouter returned HTTP ${upstream.status}. Check your OpenRouter access, credit and model selection.`});
            }
            const gaps = Object.fromEntries(payload.state.participants.map(p => [p.id, p.turns_since_last_spoke ?? 0]));
            const decision = parseDecision(await upstream.json(),eligibleIds,{gaps, gapBonus:payload.gapBonus});
            if (!res.destroyed) res.json({...decision,elapsedMs:Date.now()-started});
        } catch(e) {
            if (!res.destroyed) res.status(502).json({error:controller.signal.aborted ? 'Routing request stopped or timed out.' : 'Routing failed: the service was unreachable or its response did not match the expected Choice format.'});
        } finally {
            clearTimeout(timeout); res.off('close',disconnect); active.delete(user);
        }
    });
    console.info('[Jev Speaker Router] Plugin 0.5.2 loaded.');
}
