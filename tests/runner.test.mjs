import test from 'node:test';
import assert from 'node:assert/strict';
import {runTurns} from '../extensions/jev-speaker-router/runner.js';
import {substituteForParticipant} from '../extensions/jev-speaker-router/context.js';
function fixture(choices=['C1','C1','C1','USER']) {
 const calls=[];let current=true;
 return {calls,setCurrent:v=>current=v,adapter:{capture:async()=>{calls.push('capture');return {};},decide:async()=>{calls.push('decide');return {selected:choices.shift()};},isCurrent:()=>current,display:()=>calls.push('display'),generate:async()=>{calls.push('generate');}}};
}
test('three response limit stops without a fourth API request',async()=>{const f=fixture();assert.deepEqual(await runTurns(f.adapter),{reason:'limit',count:3});assert.equal(f.calls.filter(x=>x==='decide').length,3);});
test('USER ends loop immediately',async()=>{const f=fixture(['USER']);assert.deepEqual(await runTurns(f.adapter),{reason:'user',count:0});assert.ok(!f.calls.includes('generate'));});
test('USER after character yields without another response',async()=>{const f=fixture(['C1','USER']);assert.deepEqual(await runTurns(f.adapter),{reason:'user',count:1});});
test('dry run does not generate',async()=>{const f=fixture();assert.deepEqual(await runTurns(f.adapter,{dryRun:true}),{reason:'dry-run',count:0});});
test('stale state cannot generate',async()=>{const f=fixture();f.setCurrent(false);assert.deepEqual(await runTurns(f.adapter),{reason:'changed',count:0});assert.ok(!f.calls.includes('generate'));});
test('cancellation during Jev request cannot generate',async()=>{const f=fixture(),c=new AbortController();f.adapter.decide=async()=>{c.abort();return {selected:'C1'};};assert.equal((await runTurns(f.adapter,{signal:c.signal})).reason,'stopped');assert.ok(!f.calls.includes('generate'));});
test('cancellation during generation prevents subsequent routing',async()=>{const f=fixture(),c=new AbortController();f.adapter.generate=async()=>c.abort();assert.deepEqual(await runTurns(f.adapter,{signal:c.signal}),{reason:'stopped',count:1});assert.equal(f.calls.filter(x=>x==='decide').length,1);});
test('generation failure does not launch next decision',async()=>{const f=fixture();f.adapter.generate=async()=>{throw new Error('failure');};await assert.rejects(runTurns(f.adapter),/failure/);assert.equal(f.calls.filter(x=>x==='decide').length,1);});
test('configured limit is honoured',async()=>{const f=fixture();assert.equal((await runTurns(f.adapter,{limit:1})).count,1);});
test('macro adapter supplies per-character options object',()=>{const mock=(text,options={})=>text.replaceAll('{{char}}',options.name2Override||'');assert.equal(substituteForParticipant(mock,'{{char}} is here.','New character'),'New character is here.');});
