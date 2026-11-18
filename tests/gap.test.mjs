import test from 'node:test';
import assert from 'node:assert/strict';
import {buildState} from '../extensions/jev-speaker-router/context.js';
import {applyGapBonus, parseDecision, makeRequest} from '../plugins/jev-speaker-router/decision.mjs';

const base = (chat) => ({groupId:1, name1:'Dre', groups:[{id:1, members:['a.png','b.png','c.png']}], characters:[{avatar:'a.png', name:'A'}, {avatar:'b.png', name:'B'}, {avatar:'c.png', name:'C'}], chatMetadata:{}, chat});
const gaps = (chat) => {
    const s = buildState(base(chat), {});
    return Object.fromEntries(s.participants.map(p => [p.id, p.turns_since_last_spoke]));
};
const char = (avatar, mes = 'Hi') => ({original_avatar: avatar, mes});
const user = (mes = 'Hi') => ({is_user: true, mes});

test('last speaker gap is zero, earlier speakers count character turns', () => {
    const g = gaps([char('a.png'), char('b.png'), char('c.png')]);
    assert.equal(g.C3, 0);
    assert.equal(g.C2, 1);
    assert.equal(g.C1, 2);
    assert.equal(g.USER, null);
});
test('user messages do not count as character turns and do not reset gaps', () => {
    const g = gaps([char('a.png'), user(), char('b.png'), user()]);
    assert.equal(g.C2, 0);
    assert.equal(g.C1, 1);
});
test('system notes and empty messages do not count', () => {
    const g = gaps([char('a.png'), {is_system: true, mes: 'Note'}, {original_avatar: 'b.png', mes: '  '}, char('b.png')]);
    assert.equal(g.C2, 0);
    assert.equal(g.C1, 1);
});
test('never-spoken participant gets total character turns, saturating the bonus', () => {
    const g = gaps([char('a.png'), char('b.png')]);
    assert.equal(g.C3, 2);
});
test('gap bonus is zero at strength zero and for the just-spoken speaker', () => {
    const p = {USER: 0.2, C1: 0.8};
    const r = applyGapBonus(p, ['USER', 'C1'], {C1: 0}, 0);
    assert.deepEqual(r.bonuses, {USER: 0, C1: 0});
    assert.equal(r.adjustedProbabilities.C1, 0.8);
});
test('gap bonus lifts a long-silent character and never bonuses USER', () => {
    const p = {USER: 0.5, C1: 0.46, C2: 0.04};
    const r = applyGapBonus(p, ['USER', 'C1', 'C2'], {C1: 0, C2: 10}, 100);
    assert.equal(r.bonuses.USER, 0);
    assert.equal(r.bonuses.C2, 0.5);
    assert.ok(r.adjustedProbabilities.C2 > p.C2);
    assert.ok(Math.abs(Object.values(r.adjustedProbabilities).reduce((s, v) => s + v, 0) - 1) < 1e-9);
});
test('gap bonus at default 33 tips a close call but not a clear win', () => {
    const close = applyGapBonus({C1: 0.35, C2: 0.30}, ['C1', 'C2'], {C1: 0, C2: 10}, 33);
    assert.ok(close.adjustedProbabilities.C2 > close.adjustedProbabilities.C1);
    const clear = applyGapBonus({C1: 0.70, C2: 0.05}, ['C1', 'C2'], {C1: 0, C2: 10}, 33);
    assert.ok(clear.adjustedProbabilities.C1 > clear.adjustedProbabilities.C2);
});
test('parseDecision picks highest adjusted score, not raw, and keeps raw probabilities', () => {
    const data = {model: 'test', answers: {next_speaker: {type: 'choice', choice: 'C1', probabilities: {C1: 0.6, C2: 0.4}}}};
    const d = parseDecision(data, ['C1', 'C2'], {gaps: {C1: 0, C2: 10}, gapBonus: 100});
    assert.equal(d.selected, 'C2');
    assert.equal(d.probabilities.C1, 0.6);
    assert.equal(d.bonuses.C2, 0.5);
});
test('makeRequest validates gap bonus and keeps it out of the upstream shape', () => {
    const state = buildState(base([user()]), {});
    assert.equal(makeRequest({state, gapBonus: 33}).gapBonus, 33);
    assert.equal(makeRequest({state}).gapBonus, 0);
    assert.throws(() => makeRequest({state, gapBonus: 101}), /Invalid gap bonus/);
    assert.throws(() => makeRequest({state, gapBonus: 'high'}), /Invalid gap bonus/);
});
