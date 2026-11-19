import assert from 'node:assert/strict';
import test from 'node:test';
import { roundBonus, scoreHand } from '../src/shared/scoring.ts';

const ordinary = [0, 1, 2, 9, 10, 11, 18, 19, 20, 21, 22, 23, 3, 3];
const score = (overrides: Partial<Parameters<typeof scoreHand>[0]> = {}) => scoreHand({
  hand: ordinary,
  melds: [],
  seat: 0,
  joker: 33,
  winningTile: 23,
  source: 'selfDraw',
  multiplier: 1,
  ...overrides,
});

test('round multiplier does not qualify a one-point hand', () => {
  assert.equal(score({ hand: [...ordinary.slice(0, -1), 33], multiplier: 2 }), null);
  assert.equal(score({ multiplier: 2 })?.total, 4);
});

test('an incomplete hand does not qualify even with opening bonuses', () => {
  assert.equal(score({ hand: ordinary.slice(1), opening: 'heaven' }), null);
});

test('gold and seat-wind kong premiums stack with open or closed kong value', () => {
  const result = score({
    hand: [0, 1, 2, 9, 9],
    winningTile: 9,
    melds: [
      { kind: 'openKong', tile: 27 },
      { kind: 'closedKong', tile: 31 },
      { kind: 'addedKong', tile: 28 },
    ],
  });
  assert.deepEqual(result?.lines.slice(2), [
    { label: '自风明杠', points: 2 },
    { label: '金张暗杠', points: 3 },
    { label: '明杠', points: 1 },
  ]);
  assert.equal(result?.total, 8);
});

test('only the winner’s wind and naturally formed gold pungs add a point', () => {
  const hand = [27, 27, 27, 31, 31, 31, 0, 1, 2, 9, 10, 11, 18, 18];
  assert.equal(score({ hand, winningTile: 18 })?.base, 4);
  assert.equal(score({ hand, winningTile: 18, seat: 1 })?.base, 3);
  assert.deepEqual(score({ hand: [33, ...hand.slice(1)], winningTile: 18 })?.lines, [
    { label: '底胡', points: 1 },
    { label: '金张刻', points: 1 },
  ]);
});

test('honors distinguish mixed one suit from pure one suit', () => {
  const suitedSets = [0, 1, 2, 2, 3, 4, 3, 4, 5, 6, 7, 8];
  assert.equal(score({ hand: [...suitedSets, 1, 1], winningTile: 1 })?.base, 12);
  assert.equal(score({ hand: [...suitedSets, 28, 28], winningTile: 28 })?.base, 5);
});

test('four exposed sets score 大吊车 and preserve other scoring patterns', () => {
  const result = score({
    hand: [19, 19],
    winningTile: 19,
    melds: [0, 2, 9, 10].map(tile => ({ kind: 'pong', tile })),
  });
  assert.equal(result?.base, 6);
  assert.ok(result?.lines.some(line => line.label === '大吊车' && line.points === 1));
});

test('绕搭 and 丢搭 can win by self-draw but cannot rob a kong', () => {
  const hand = [...ordinary.slice(0, -1), 33];
  assert.equal(score({ hand, winningTile: 3 })?.base, 2);
  assert.equal(score({ hand, winningTile: 3, source: 'robKong' }), null);
  assert.equal(score({ discardedJoker: true })?.base, 2);
  assert.equal(score({ discardedJoker: true, source: 'robKong' }), null);
  assert.equal(score({ source: 'robKong' })?.base, 4);
});

test('three jokers add ten points to a formed hand and require a legal tile count', () => {
  const hand = [0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 27, 33, 33, 33];
  assert.ok(score({ hand, winningTile: 33 })?.lines.some(line => line.label === '三财神' && line.points === 10));
  assert.equal(score({ hand: hand.slice(1), winningTile: 33 }), null);
});

test('single bonus triggers apply only to the current round', () => {
  assert.deepEqual(roundBonus([1, 2], 0, 0), { multiplier: 1, streakRound: 0, remaining: 0 });
  assert.deepEqual(roundBonus([2, 2], 7, 0), { multiplier: 2, streakRound: 0, remaining: 0 });
  for (const honor of [27, 28, 29, 30, 31, 32, 33]) {
    assert.deepEqual(roundBonus([2, 4], honor, 0), { multiplier: 2, streakRound: 0, remaining: 0 });
  }
});

test('both triggers start or restart three doubled rounds without quadrupling', () => {
  assert.deepEqual(roundBonus([3, 3], 30, 0), { multiplier: 2, streakRound: 1, remaining: 2 });
  assert.deepEqual(roundBonus([2, 3], 1, 2), { multiplier: 2, streakRound: 2, remaining: 1 });
  assert.deepEqual(roundBonus([2, 2], 1, 1), { multiplier: 2, streakRound: 3, remaining: 0 });
  assert.deepEqual(roundBonus([1, 3], 1, 0), { multiplier: 1, streakRound: 0, remaining: 0 });
  assert.deepEqual(roundBonus([3, 3], 31, 1), { multiplier: 2, streakRound: 1, remaining: 2 });
});
test('rotating seat winds apply to concealed sets and melds, while gold stays fixed', () => {
  const hand=[27,27,27,31,31,31,0,1,2,9,10,11,18,18];
  for(const banker of [0,1,2,3] as const){
    const win=score({seat:banker,banker,hand,winningTile:18});
    assert.ok(win?.lines.some(l=>l.label==='自风刻'));
    assert.ok(win?.lines.some(l=>l.label==='金张刻'));
    const exposed=score({seat:((banker+1)%4) as 0|1|2|3,banker,hand:hand.slice(3),melds:[{kind:'openKong',tile:28}],winningTile:18});
    assert.ok(exposed?.lines.some(l=>l.label==='自风明杠'));
  }
  assert.ok(!score({rulesVersion:'wj-1',seat:2,banker:2,hand,winningTile:18})?.lines.some(l=>l.label==='自风刻'));
});
test('unformed three-joker hand wins ten multiplied points only on its own draw',()=>{
  const hand=[0,3,6,9,12,15,18,21,24,27,29,33,33,33];
  const input={hand,winningTile:33,multiplier:2 as const};
  assert.deepEqual(score(input),{lines:[{label:'三财神',points:10}],base:10,total:20});
  assert.equal(score({...input,rulesVersion:'wj-1'}),null);
  assert.equal(score({...input,source:'robKong'}),null);
  const normal=score({hand:[0,1,2,9,10,11,18,19,20,27,27,33,33,33],winningTile:33});
  assert.equal(normal?.lines.filter(l=>l.label==='三财神').length,1);
  assert.ok(normal!.base>10);
});
