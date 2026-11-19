import { seatWind } from './protocol.ts';
import type { Dice, HandScore, Meld, ScoreLine, Seat, Tile } from './protocol.ts';

interface ScoreInput {
  banker?: Seat;
  rulesVersion?: string;
  hand: Tile[];
  melds: Meld[];
  seat: Seat;
  joker: Tile;
  winningTile: Tile;
  source: 'selfDraw' | 'robKong';
  multiplier: 1 | 2;
  discardedJoker?: boolean;
  afterKong?: boolean;
  lastTile?: boolean;
  opening?: 'heaven' | 'earth';
}

interface RoundBonus {
  multiplier: 1 | 2;
  streakRound: 0 | 1 | 2 | 3;
  remaining: number;
}

const tileKinds = 34;
const firstHonor = 27;
const firstGold = 31;
const tileTypes = Array.from({ length: tileKinds }, (_, tile) => tile);

interface Group {
  kind: 'pair' | 'pung' | 'sequence';
  tile: Tile;
  wilds: number;
}

function isTile(tile: Tile): boolean {
  return Number.isInteger(tile) && tile >= 0 && tile < tileKinds;
}

function countConcealed(input: ScoreInput): number[] | null {
  if (!isTile(input.joker) || input.melds.length > 4 ||
      input.hand.length !== (4 - input.melds.length) * 3 + 2 ||
      !input.hand.includes(input.winningTile)) {
    return null;
  }
  const counts: number[] = Array(tileKinds).fill(0);
  for (const tile of input.hand) {
    if (!isTile(tile) || ++counts[tile] > 4) return null;
  }
  const physical = counts.slice();
  for (const meld of input.melds) {
    if (!isTile(meld.tile)) return null;
    physical[meld.tile] += meld.kind === 'pong' ? 3 : 4;
    if (physical[meld.tile] > 4) return null;
  }
  return counts;
}

// Anchor each set on the first remaining natural tile. A wildcard may take a
// slot even if its natural tile is present, preserving that tile for another set.
function findGroups(
  counts: number[], wilds: number, sets: number, groups: Group[],
  visit: (groups: Group[]) => void,
): void {
  if (sets === 0) {
    visit(groups);
    return;
  }
  const first = counts.findIndex(count => count > 0);
  if (first === -1) {
    // At most four jokers exist, so at most one set can be entirely wild.
    if (sets === 1 && wilds === 3) {
      for (const tile of tileTypes) visit([...groups, { kind: 'pung', tile, wilds: 3 }]);
    }
    return;
  }

  for (let natural = 1; natural <= Math.min(3, counts[first]); natural++) {
    const missing = 3 - natural;
    if (missing > wilds) continue;
    counts[first] -= natural;
    groups.push({ kind: 'pung', tile: first, wilds: missing });
    findGroups(counts, wilds - missing, sets - 1, groups, visit);
    groups.pop();
    counts[first] += natural;
  }

  if (first >= firstHonor) return;
  const rank = first % 9;
  const suitStart = first - rank;
  for (let start = Math.max(0, rank - 2); start <= Math.min(rank, 6); start++) {
    const sequence = [suitStart + start, suitStart + start + 1, suitStart + start + 2];
    const neighbors = sequence.filter(tile => tile !== first);
    for (const useLeft of [true, false]) {
      for (const useRight of [true, false]) {
        const [left, right] = neighbors;
        if ((useLeft && counts[left] === 0) || (useRight && counts[right] === 0)) continue;
        const missing = Number(!useLeft) + Number(!useRight);
        if (missing > wilds) continue;
        counts[first]--;
        if (useLeft) counts[left]--;
        if (useRight) counts[right]--;
        groups.push({ kind: 'sequence', tile: sequence[0], wilds: missing });
        findGroups(counts, wilds - missing, sets - 1, groups, visit);
        groups.pop();
        if (useRight) counts[right]++;
        if (useLeft) counts[left]++;
        counts[first]++;
      }
    }
  }
}

function goldOrSeatWind(tile: Tile, seat: Seat): string {
  if (tile >= firstGold) return '金张';
  return tile === firstHonor + seat ? '自风' : '';
}

function scoreMeld(meld: Meld, seat: Seat): ScoreLine[] {
  const premium = goldOrSeatWind(meld.tile, seat);
  if (meld.kind === 'pong') return premium ? [{ label: `${premium}刻`, points: 1 }] : [];
  const hidden = meld.kind === 'closedKong';
  return [{ label: `${premium}${hidden ? '暗杠' : '明杠'}`, points: (hidden ? 2 : 1) + Number(Boolean(premium)) }];
}

function scoreGroups(groups: Group[], input: ScoreInput): ScoreLine[] {
  const tiles = [...groups.map(group => group.tile), ...input.melds.map(meld => meld.tile)];
  const suits = new Set(tiles.filter(tile => tile < firstHonor).map(tile => Math.floor(tile / 9)));
  const lines: ScoreLine[] = [];
  if (suits.size === 1) {
    lines.push(tiles.some(tile => tile >= firstHonor)
      ? { label: '混一色', points: 3 }
      : { label: '清一色', points: 10 });
  }
  if (groups.every(group => group.kind !== 'sequence')) lines.push({ label: '碰碰胡', points: 3 });

  for (const group of groups) {
    if (group.kind !== 'pung' || group.wilds > 0) continue;
    const premium = goldOrSeatWind(group.tile, seatWind(input.seat, input.banker ?? 0, input.rulesVersion));
    if (premium) lines.push({ label: `${premium}刻`, points: 1 });
  }
  return lines;
}

export function scoreHand(input: ScoreInput): HandScore | null {
  const counts = countConcealed(input);
  if (!counts) return null;
  const wilds = counts[input.joker];
  const robbing = input.source === 'robKong';
  if (robbing && input.discardedJoker && wilds === 0) return null;
  counts[input.joker] = 0;

  const fixed: ScoreLine[] = [{ label: '底胡', points: 1 }];
  if (wilds === 0) fixed.push({ label: input.discardedJoker ? '丢搭' : '无百搭', points: 1 });
  if (wilds === 3) fixed.push({ label: '三财神', points: 10 });
  if (input.melds.length === 4) fixed.push({ label: '大吊车', points: 1 });
  if (robbing) fixed.push({ label: '抢杠', points: 2 });
  if (input.afterKong) fixed.push({ label: '杠上开花', points: 1 });
  if (input.lastTile) fixed.push({ label: '海底捞月', points: 1 });
  if (input.opening) fixed.push({ label: input.opening === 'heaven' ? '天胡' : '地胡', points: 10 });
  fixed.push(...input.melds.flatMap(meld => scoreMeld(meld, seatWind(input.seat, input.banker ?? 0, input.rulesVersion))));

  let best: HandScore | null = null;
  let singleJokerWait = false;
  for (const tile of tileTypes) {
    for (let natural = Math.min(2, counts[tile]); natural >= 0; natural--) {
      const missing = 2 - natural;
      if (missing > wilds) continue;
      const waitsOnJoker = (missing === 1 && tile === input.winningTile) ||
        (missing === 2 && input.winningTile === input.joker);
      counts[tile] -= natural;
      const pair: Group = { kind: 'pair', tile, wilds: missing };
      findGroups(counts, wilds - missing, 4 - input.melds.length, [pair], groups => {
        if (waitsOnJoker) singleJokerWait = true;
        const lines = [...fixed, ...scoreGroups(groups, input)];
        if (waitsOnJoker) lines.push({ label: '绕搭', points: 1 });
        const base = lines.reduce((total, line) => total + line.points, 0);
        if (base >= 2 && (!best || base > best.base)) {
          best = { lines, base, total: base * input.multiplier };
        }
      });
      counts[tile] += natural;
    }
  }
  if (!best && wilds === 3 && !robbing && input.rulesVersion !== 'wj-1') {
    return { lines: [{ label: '三财神', points: 10 }], base: 10, total: 10 * input.multiplier };
  }
  return robbing && singleJokerWait ? null : best;
}

export function roundBonus(dice: Dice, joker: Tile, remaining: number): RoundBonus {
  const honorJoker = joker >= firstHonor && joker < tileKinds;
  const doubles = dice[0] === dice[1];
  if (honorJoker && doubles) return { multiplier: 2, streakRound: 1, remaining: 2 };
  if (remaining === 3) return { multiplier: 2, streakRound: 1, remaining: 2 };
  if (remaining === 2) return { multiplier: 2, streakRound: 2, remaining: 1 };
  if (remaining === 1) return { multiplier: 2, streakRound: 3, remaining: 0 };
  return { multiplier: honorJoker || doubles ? 2 : 1, streakRound: 0, remaining: 0 };
}
