import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
const url=new URL('../plugins/jev-speaker-router/index.mjs',import.meta.url);
let source=await readFile(url,'utf8');
source=source.replace("import express from 'express';","const express={json:()=>()=>{}};")
 .replace("import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';","const SECRET_KEYS={OPENROUTER:'openrouter'}; const readSecret=(dirs)=>dirs.testKey;")
 .replace("'./decision.mjs'",JSON.stringify(new URL('../plugins/jev-speaker-router/decision.mjs',import.meta.url).href));
const plugin=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const routes={};const middleware=[];
await plugin.init({use:fn=>middleware.push(fn),get:(path,fn)=>routes[path]=fn,post:(path,fn)=>routes[path]=fn});
function res(){const r=new EventEmitter();r.statusCode=200;r.status=n=>(r.statusCode=n,r);r.json=x=>(r.value=x,r.writableEnded=true,r);return r;}
const req=()=>({user:{directories:{root:'test-user',testKey:'test-only-secret'}},body:{state:{participants:[{id:'USER',name:'Dre'},{id:'C1',name:'Luna'}],recent_messages:[]}}});
test('requires authenticated user',()=>{const r=res();middleware[0]({},r,()=>assert.fail());assert.equal(r.statusCode,401);});
test('missing key does not reach provider',async()=>{const q=req();q.body.state.participants.push({id:'C2',name:'Other'});q.user.directories.testKey='';const r=res();await routes['/decide'](q,r);assert.equal(r.statusCode,400);});
test('status never exposes credential',()=>{const r=res();routes['/status'](req(),r);assert.equal(r.value.credentialConfigured,true);assert.ok(!JSON.stringify(r.value).includes('test-only-secret'));});
test('provider request uses fixed endpoint and server key, validated response returned',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://openrouter.ai/api/alpha/decisions');assert.equal(options.headers.Authorization,'Bearer test-only-secret');assert.equal(JSON.parse(options.body).questions.next_speaker.type,'choice');return {ok:true,json:async()=>({answers:{next_speaker:{type:'choice',choice:'USER',probabilities:{USER:1,C1:0,C2:0}}}})};};
 try{const q=req();q.body.state.participants.push({id:'C2',name:'Other'});const r=res();await routes['/decide'](q,r);assert.equal(r.value.selected,'USER');assert.ok(!JSON.stringify(r.value).includes('test-only-secret'));}finally{globalThis.fetch=original;}
});
test('upstream errors do not echo provider bodies or keys',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:401,body:{cancel:async()=>{}}});try{const q=req();q.body.state.participants.push({id:'C2',name:'Other'});const r=res();await routes['/decide'](q,r);assert.equal(r.statusCode,502);assert.match(r.value.error,/401/);}finally{globalThis.fetch=original;}});
test('concurrent same-user request rejected; disconnect cancels and releases slot',async()=>{
 const original=globalThis.fetch;let signal;
 globalThis.fetch=async(_url,opts)=>new Promise((_resolve,reject)=>{signal=opts.signal;signal.addEventListener('abort',()=>reject(new Error('aborted')));});
 try{const q1=req();q1.body.state.participants.push({id:'C2',name:'Other'});const q2=req();q2.body.state.participants.push({id:'C2',name:'Other'});const r1=res();const pending=routes['/decide'](q1,r1);const r2=res();await routes['/decide'](q2,r2);assert.equal(r2.statusCode,429);r1.destroyed=true;r1.emit('close');await pending;assert.equal(signal.aborted,true);}finally{globalThis.fetch=original;}
});
test('single remaining character is chosen without an API call',async()=>{const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('No provider request for one candidate');try{const q=req();q.body.state.participants.push({id:'C2',name:'Other'});q.body.routing={mode:'continue_other',excluded_id:'C1'};const r=res();await routes['/decide'](q,r);assert.equal(r.value.selected,'C2');assert.deepEqual(r.value.probabilities,{C2:1});assert.match(r.value.model,/no API call/);}finally{globalThis.fetch=original;}});
test('sole eligible character is chosen without an API call even when USER is also eligible',async()=>{const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('No provider request for sole character');try{const q=req();const r=res();await routes['/decide'](q,r);assert.equal(r.value.selected,'C1');assert.deepEqual(r.value.probabilities,{C1:1,USER:0});assert.match(r.value.model,/Only eligible character/);}finally{globalThis.fetch=original;}});
for (const previous of ['USER','C1']) test(`endpoint excludes ${previous} from the actual provider request`,async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);const ids=Object.keys(payload.questions.next_speaker.criteria);assert.ok(!ids.includes(previous));assert.ok(ids.includes('C2'));return {ok:true,json:async()=>({answers:{next_speaker:{type:'choice',choice:'C2',probabilities:Object.fromEntries(ids.map(id=>[id,id==='C2'?1:0]))}}})};};
 try{const q=req();q.body.state.participants.push({id:'C2',name:'Other'});q.body.state.last_speaker=previous;const r=res();await routes['/decide'](q,r);assert.equal(r.value.selected,'C2');}finally{globalThis.fetch=original;}
});
