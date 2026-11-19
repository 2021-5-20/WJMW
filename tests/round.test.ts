import assert from 'node:assert/strict';
import test from 'node:test';
import type { Seat, Tile } from '../src/shared/protocol.ts';
import { applyAction, createRound, remainingStreak, timeoutRound, viewRound } from '../src/shared/round.ts';

function wall(planned: Record<number, Tile> = {}): Tile[] {
  const ordered = Array<Tile>(136).fill(-1);
  const counts = Array<number>(34).fill(4);
  for (const [index, tile] of Object.entries(planned)) {
    ordered[Number(index)] = tile;
    counts[tile]--;
  }
  const rest = counts.flatMap((count, tile) => Array<Tile>(count).fill(tile));
  const rotated = ordered.map(tile => tile < 0 ? rest.shift()! : tile);
  return [...rotated.slice(-36), ...rotated.slice(0, -36)]; // [1, 1] from east opens at index 36
}

test('opening hands are independent and other hand values are private', () => {
  const round = createRound(0, 0, { dice: [1, 1], deck: wall({ 134: 32 }) });
  const east = viewRound(round, 0);
  const south = viewRound(round, 1);
  assert.equal(east.hand.length, 14);
  assert.equal(south.hand.length, 13);
  assert.equal(east.drawnTile, east.hand.at(-1));
  assert.equal(south.drawnTile, undefined);
  assert.notDeepEqual(east.hand, south.hand);
  assert.deepEqual(east.players.map(player => player.handCount), [14, 13, 13, 13]);
  assert.ok(east.players.every(player => !Object.hasOwn(player, 'hand')));
  assert.equal(east.joker, 32);
  assert.equal(east.multiplier, 2);
  assert.equal(east.streakRound, 1);
  assert.equal(round.bonus.remaining, 2);
  assert.equal(east.wallCount, 81);
  assert.deepEqual(south.actions, []);
});

test('only the current player can discard and a pong takes the discard off the table', () => {
  const round = createRound(0, 0, { dice: [1, 1], deck: wall({ 0: 27, 4: 27, 5: 27, 134: 33 }) });
  assert.throws(() => applyAction(round, 1, { type: 'discard', tile: 27 }));
  applyAction(round, 0, { type: 'discard', tile: 27 });
  assert.throws(() => applyAction(round, 0, { type: 'discard', tile: 27 }));
  assert.ok(viewRound(round, 1).actions.some(action => action.type === 'pong' && action.tile === 27));
  applyAction(round, 1, { type: 'pong', tile: 27 });
  const south = viewRound(round, 1);
  assert.equal(south.turn, 1);
  assert.equal(south.hand.length, 11);
  assert.deepEqual(south.players[0].discards, []);
  assert.deepEqual(south.players[1].melds, [{ kind: 'pong', tile: 27, from: 0 }]);
});

test('a concealed kong stays concealed from other seats and draws a supplement', () => {
  const round = createRound(0, 0, { dice: [1, 1], deck: wall({ 0: 28, 1: 28, 2: 28, 3: 28, 134: 33, 135: 31 }) });
  applyAction(round, 0, { type: 'closedKong', tile: 28 });
  assert.deepEqual(viewRound(round, 0).players[0].melds, [{ kind: 'closedKong', tile: 28 }]);
  assert.deepEqual(viewRound(round, 1).players[0].melds, [{ kind: 'closedKong', tile: null }]);
  assert.equal(viewRound(round, 0).hand.at(-1), 31);
  assert.equal(viewRound(round, 0).hand.length, 11);
});

test('winning on a reserve supplement does not score the last ordinary tile', () => {
  const hand = [28, 28, 28, 28, 0, 1, 2, 9, 10, 11, 18, 19, 20, 33];
  const eastSlots = [0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 52];
  const plan = Object.fromEntries(eastSlots.map((slot, index) => [slot, hand[index]]));
  Object.assign(plan, { 134: 32, 135: 33 });
  const round = createRound(0, 0, { dice: [1, 1], deck: wall(plan) });
  round.wall.length = 0;
  applyAction(round, 0, { type: 'closedKong', tile: 28 });
  applyAction(round, 0, { type: 'hu' });
  const labels = round.result?.score?.lines.map(line => line.label);
  assert.ok(labels?.includes('杠上开花'));
  assert.ok(!labels?.includes('海底捞月'));
});

test('a ready hand may rob an added kong before it is recorded', () => {
  const northHand = [0, 1, 9, 10, 11, 18, 19, 20, 30, 30, 30, 26, 26];
  const northSlots = [12, 13, 14, 15, 28, 29, 30, 31, 44, 45, 46, 47, 51];
  const plan = Object.fromEntries(northSlots.map((slot, index) => [slot, northHand[index]]));
  Object.assign(plan, { 0: 2, 4: 2, 5: 2, 53: 31, 54: 32, 55: 8, 56: 2, 134: 33 });
  const round = createRound(0, 0, { dice: [1, 1], deck: wall(plan) });
  applyAction(round, 0, { type: 'discard', tile: 2 });
  applyAction(round, 1, { type: 'pong', tile: 2 });
  for (let step = 0; step < 24 && !viewRound(round, 1).actions.some(action => action.type === 'addedKong'); step++) {
    timeoutRound(round);
  }
  applyAction(round, 1, { type: 'addedKong', tile: 2 });
  assert.equal(viewRound(round, 3).pending?.kind, 'addedKong');
  const southHand = viewRound(round, 1).hand.filter(tile => tile !== 2);
  applyAction(round, 3, { type: 'hu' });
  assert.equal(round.result?.winner, 3);
  assert.equal(round.result?.source, 'robKong');
  assert.deepEqual(round.result?.deltas, [0, -30, 0, 30]);
  assert.equal(viewRound(round, 1).players[1].melds[0].kind, 'pong');
  assert.deepEqual(viewRound(round, 1).hand, southHand);
});

test('timeouts can finish a full round and a draw keeps the banker', () => {
  const round = createRound(0, 0, { dice: [1, 1], deck: wall() });
  for (let step = 0; !round.result && step < 400; step++) timeoutRound(round);
  assert.equal(round.result?.source, 'draw');
  assert.equal(round.banker, 0 satisfies Seat);
  assert.deepEqual(round.result?.deltas, [0, 0, 0, 0]);
});

test('draw replays each active streak stage; a new double trigger restarts at one',()=>{
  for(const remaining of [3,2,1]){
    const r=createRound(0,remaining,{dice:[1,2]});
    r.result={source:'draw',winner:null,deltas:[0,0,0,0]};
    assert.equal(remainingStreak(r),remaining);
    const replay=createRound(0,remainingStreak(r),{dice:[1,2]});
    assert.equal(replay.bonus.streakRound,r.bonus.streakRound);
    const restarted=createRound(0,remainingStreak(r),{dice:[1,1],deck:wall({134:33})});
    assert.equal(restarted.bonus.streakRound,1);
    restarted.result=r.result;
    assert.equal(remainingStreak(restarted),3);
    for(const source of ['selfDraw','robKong'] as const){
      r.result={source,winner:0,deltas:[3,-1,-1,-1]};
      assert.equal(remainingStreak(r),remaining-1);
    }
    r.rulesVersion='wj-1';
    r.result={source:'draw',winner:null,deltas:[0,0,0,0]};
    assert.equal(remainingStreak(r),remaining-1);
  }
});
test('direct joker win is offered after either ordinary draw or supplement',()=>{
  for(const afterKong of [false,true]){
    const r=createRound(2,0);
    r.players[2].hand=[0,3,6,9,12,15,18,21,24,27,29,33,33,33];
    r.joker=33;r.drawnTile=33;r.drewAfterKong=afterKong;
    assert.ok(viewRound(r,2).actions.some(a=>a.type==='hu'));
    applyAction(r,2,{type:'hu'});
    assert.equal(r.result?.score?.base,10);
    assert.deepEqual(r.result?.deltas,[-10,-10,30,-10].map(x=>x*r.bonus.multiplier));
  }
});
