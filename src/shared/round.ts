import type { Action, Dice, Meld, RoundResult, RoundView, Seat, Tile } from './protocol.ts';
import { roundBonus, scoreHand } from './scoring.ts';

const seats = [0, 1, 2, 3] as const;
const nextSeat = (seat: Seat, offset = 1): Seat => seats[(seat + offset) % 4];
const countTile = (hand: Tile[], tile: Tile) => hand.filter(value => value === tile).length;

interface PlayerState {
  hand: Tile[];
  melds: Meld[];
  discards: Tile[];
  discardedJoker: boolean;
}

interface Pending {
  from: Seat;
  tile: Tile;
  kind: 'discard' | 'addedKong';
  options: Map<Seat, Action[]>;
  replies: Map<Seat, Action>;
}

export interface RoundState {
  rulesVersion?: string;
  banker: Seat;
  turn: Seat;
  dice: Dice;
  joker: Tile;
  bonus: ReturnType<typeof roundBonus>;
  players: PlayerState[];
  wall: Tile[];
  supplements: Tile[];
  revision: number;
  drawnTile?: Tile;
  drewAfterKong: boolean;
  hasClaim: boolean;
  pending?: Pending;
  result?: RoundResult;
}

function shuffleWall(randomInt: (limit: number) => number): Tile[] {
  const deck = Array.from({ length: 136 }, (_, index) => Math.floor(index / 4));
  for (let index = deck.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

export function createRound(banker: Seat, remaining: number, options: { rulesVersion?: string; deck?: Tile[]; dice?: Dice; randomInt?: (limit: number) => number } = {}): RoundState {
  const randomInt = options.randomInt ?? ((limit: number) => Math.floor(Math.random() * limit));
  const dice: Dice = options.dice ?? [randomInt(6) + 1, randomInt(6) + 1];
  const deck = options.deck ?? shuffleWall(randomInt);
  if (deck.length !== 136 || Array.from({ length: 34 }, (_, tile) => countTile(deck, tile)).some(count => count !== 4)) {
    throw new Error('牌墙必须包含每种牌各四张');
  }
  if (dice.some(value => !Number.isInteger(value) || value < 1 || value > 6)) throw new Error('骰点无效');
  const openingSide = nextSeat(banker, dice[0] + dice[1] - 1);
  const openingIndex = (openingSide * 34 + Math.max(...dice) * 2) % deck.length;
  const rotated = [...deck.slice(openingIndex), ...deck.slice(0, openingIndex)];
  const indicator = rotated.length - Math.min(...dice) * 2;
  const joker = rotated[indicator];
  const players: PlayerState[] = seats.map(() => ({ hand: [], melds: [], discards: [], discardedJoker: false }));
  let drawIndex = 0;
  for (const count of [4, 4, 4, 1]) {
    for (const offset of seats) {
      players[nextSeat(banker, offset)].hand.push(...rotated.slice(drawIndex, drawIndex + count));
      drawIndex += count;
    }
  }
  const drawnTile = rotated[drawIndex++];
  players[banker].hand.push(drawnTile);
  return {
    rulesVersion: options.rulesVersion ?? 'wj-2', banker, turn: banker, dice, joker, players, drawnTile,
    bonus: roundBonus(dice, joker, remaining),
    wall: rotated.slice(drawIndex, indicator), supplements: rotated.slice(indicator + 1),
    revision: 0, drewAfterKong: false, hasClaim: false,
  };
}

function score(state: RoundState, seat: Seat, tile: Tile, source: 'selfDraw' | 'robKong') {
  const player = state.players[seat];
  const selfDraw = source === 'selfDraw';
  const opening = selfDraw && !state.hasClaim && player.discards.length === 0
    ? seat === state.banker ? 'heaven' : 'earth'
    : undefined;
  return scoreHand({
    hand: selfDraw ? player.hand : [...player.hand, tile],
    melds: player.melds,
    seat, banker: state.banker, rulesVersion: state.rulesVersion ?? 'wj-1', joker: state.joker, winningTile: tile, source,
    multiplier: state.bonus.multiplier,
    discardedJoker: player.discardedJoker,
    afterKong: selfDraw && state.drewAfterKong,
    lastTile: selfDraw && !state.drewAfterKong && state.wall.length === 0,
    opening,
  });
}

function actionsFor(state: RoundState, seat: Seat): Action[] {
  if (state.result) return [];
  if (state.pending) return state.pending.replies.has(seat) ? [] : state.pending.options.get(seat) ?? [];
  if (state.turn !== seat) return [];

  const player = state.players[seat];
  const actions: Action[] = [];
  if (state.drawnTile !== undefined && score(state, seat, state.drawnTile, 'selfDraw')) actions.push({ type: 'hu' });
  const unique = [...new Set(player.hand)];
  if (canReplace(state)) {
    for (const tile of unique) {
      if (tile === state.joker) continue;
      if (countTile(player.hand, tile) === 4) actions.push({ type: 'closedKong', tile });
      if (player.melds.some(meld => meld.kind === 'pong' && meld.tile === tile)) actions.push({ type: 'addedKong', tile });
    }
  }
  return [...actions, ...unique.map(tile => ({ type: 'discard' as const, tile }))];
}

function canReplace(state: RoundState) {
  return state.supplements.length > 0 || state.wall.length > 0;
}

function removeTiles(hand: Tile[], tile: Tile, count: number) {
  for (let index = 0; index < count; index++) hand.splice(hand.indexOf(tile), 1);
}

function draw(state: RoundState, seat: Seat, supplement = false) {
  const tile = supplement ? state.supplements.pop() ?? state.wall.pop() : state.wall.shift();
  state.turn = seat;
  state.drawnTile = tile;
  state.drewAfterKong = supplement;
  if (tile === undefined) {
    state.result = { winner: null, source: 'draw', deltas: [0, 0, 0, 0] };
    return;
  }
  state.players[seat].hand.push(tile);
}

function finishWin(state: RoundState, seat: Seat, tile: Tile, from?: Seat) {
  const source = from === undefined ? 'selfDraw' : 'robKong';
  const handScore = score(state, seat, tile, source);
  if (!handScore) throw new Error('当前不能胡牌');
  const deltas = seats.map(other => {
    if (other === seat) return handScore.total * 3;
    if (from === undefined) return -handScore.total;
    return other === from ? -handScore.total * 3 : 0;
  });
  const winningHand = [...state.players[seat].hand];
  if (from !== undefined) {
    winningHand.push(tile);
    removeTiles(state.players[from].hand, tile, 1);
  }
  winningHand.sort((left, right) => left - right);
  state.result = { winner: seat, source, score: handScore, winningHand, deltas };
  state.pending = undefined;
  state.drawnTile = undefined;
}

function openResponse(state: RoundState, from: Seat, tile: Tile, kind: Pending['kind']) {
  const options = new Map<Seat, Action[]>();
  for (const seat of seats) {
    if (seat === from) continue;
    const actions: Action[] = [];
    if (kind === 'addedKong') {
      if (score(state, seat, tile, 'robKong')) actions.push({ type: 'hu' });
    } else if (tile !== state.joker) {
      const count = countTile(state.players[seat].hand, tile);
      if (count >= 2) actions.push({ type: 'pong', tile });
      if (count === 3 && canReplace(state)) actions.push({ type: 'openKong', tile });
    }
    if (actions.length) options.set(seat, [...actions, { type: 'pass' }]);
  }
  state.pending = { from, tile, kind, options, replies: new Map() };
  if (!options.size) resolveResponse(state);
}

function resolveResponse(state: RoundState) {
  const pending = state.pending!;
  const { from, tile } = pending;
  state.pending = undefined;
  for (const offset of [1, 2, 3]) {
    const seat = nextSeat(from, offset);
    const reply = pending.replies.get(seat);
    if (reply?.type === 'hu') {
      finishWin(state, seat, tile, from);
      return;
    }
    if (reply?.type === 'pong' || reply?.type === 'openKong') {
      const player = state.players[seat];
      removeTiles(player.hand, tile, reply.type === 'pong' ? 2 : 3);
      state.players[from].discards.pop();
      player.melds.push({ kind: reply.type, tile, from });
      state.hasClaim = true;
      state.turn = seat;
      state.drawnTile = undefined;
      if (reply.type === 'openKong') draw(state, seat, true);
      return;
    }
  }
  if (pending.kind === 'addedKong') {
    const player = state.players[from];
    const meld = player.melds.find(group => group.kind === 'pong' && group.tile === tile)!;
    meld.kind = 'addedKong';
    removeTiles(player.hand, tile, 1);
    draw(state, from, true);
    return;
  }
  draw(state, nextSeat(from));
}

export function applyAction(state: RoundState, seat: Seat, action: Action): void {
  const allowed = actionsFor(state, seat).some(choice => choice.type === action.type && choice.tile === action.tile);
  if (!allowed) throw new Error('当前不能执行这个操作');
  state.revision++;
  if (state.pending) {
    state.pending.replies.set(seat, action);
    if (state.pending.replies.size === state.pending.options.size) resolveResponse(state);
    return;
  }

  const player = state.players[seat];
  if (action.type === 'discard') {
    const tile = action.tile!;
    removeTiles(player.hand, tile, 1);
    player.discards.push(tile);
    player.discardedJoker ||= tile === state.joker;
    state.drawnTile = undefined;
    openResponse(state, seat, tile, 'discard');
  } else if (action.type === 'closedKong') {
    const tile = action.tile!;
    removeTiles(player.hand, tile, 4);
    player.melds.push({ kind: 'closedKong', tile });
    state.hasClaim = true;
    draw(state, seat, true);
  } else if (action.type === 'addedKong') {
    state.hasClaim = true;
    openResponse(state, seat, action.tile!, 'addedKong');
  } else if (action.type === 'hu') {
    finishWin(state, seat, state.drawnTile!);
  }
}

export function timeoutRound(state: RoundState): void {
  if (state.result) return;
  if (state.pending) {
    const pending = state.pending;
    for (const seat of pending.options.keys()) {
      if (!pending.replies.has(seat)) applyAction(state, seat, { type: 'pass' });
    }
    return;
  }
  applyAction(state, state.turn, { type: 'discard', tile: state.drawnTile ?? state.players[state.turn].hand.at(-1) });
}

export function viewRound(state: RoundState, seat: Seat | null): RoundView {
  const pending = state.pending ? { from: state.pending.from, tile: state.pending.tile, kind: state.pending.kind } : undefined;
  const hand = seat === null ? [] : [...state.players[seat].hand].sort((left, right) => left - right);
  const drawnTile = state.turn === seat && !pending && !state.result ? state.drawnTile : undefined;
  if (drawnTile !== undefined) {
    removeTiles(hand, drawnTile, 1);
    hand.push(drawnTile);
  }
  return {
    banker: state.banker, turn: state.turn, dice: state.dice, joker: state.joker,
    phase: state.result ? 'settled' : pending ? 'response' : 'turn',
    multiplier: state.bonus.multiplier, streakRound: state.bonus.streakRound,
    wallCount: state.wall.length, revision: state.revision, hand, drawnTile, pending,
    actions: seat === null ? [] : actionsFor(state, seat), result: state.result,
    players: state.players.map((player, index) => ({
      handCount: player.hand.length,
      melds: player.melds.map(meld => ({ ...meld, tile: meld.kind === 'closedKong' && index !== seat ? null : meld.tile })),
      discards: [...player.discards],
    })),
  };
}


export function remainingStreak(round: RoundState | null): number {
  if (!round) return 0;
  const replay = round.rulesVersion === 'wj-2' && round.result?.source === 'draw' && round.bonus.streakRound > 0;
  return round.bonus.remaining + Number(replay);
}
