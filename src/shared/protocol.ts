export type Seat = 0 | 1 | 2 | 3;
export type Tile = number; // 0–8 万，9–17 筒，18–26 条，27–30 风，31–33 中发白
export type Dice = readonly [number, number];
export type MeldKind = 'pong' | 'openKong' | 'closedKong' | 'addedKong';
export interface Meld { kind: MeldKind; tile: Tile; from?: Seat }
export interface PublicMeld { kind: MeldKind; tile: Tile | null; from?: Seat }
export type ActionType = 'discard' | 'pong' | 'openKong' | 'closedKong' | 'addedKong' | 'hu' | 'pass';
export interface Action { type: ActionType; tile?: Tile }
export interface ScoreLine { label: string; points: number }
export interface HandScore { lines: ScoreLine[]; base: number; total: number }
export interface RoundResult {
  winner: Seat | null;
  source: 'selfDraw' | 'robKong' | 'draw';
  score?: HandScore;
  winningHand?: Tile[];
  deltas: number[];
}

export interface PublicPlayer {
  avatar?: number;
  seat: Seat;
  name: string;
  connected: boolean;
  ready: boolean;
  points: number;
  handCount: number;
  melds: PublicMeld[];
  discards: Tile[];
}

export interface RoundView {
  banker: Seat;
  turn: Seat;
  phase: 'turn' | 'response' | 'settled';
  dice: Dice;
  joker: Tile;
  multiplier: 1 | 2;
  streakRound: 0 | 1 | 2 | 3;
  wallCount: number;
  revision: number;
  hand: Tile[];
  drawnTile?: Tile;
  actions: Action[];
  pending?: { from: Seat; tile: Tile; kind: 'discard' | 'addedKong' };
  players: { handCount: number; melds: PublicMeld[]; discards: Tile[] }[];
  result?: RoundResult;
}

export interface RoomView {
  rulesVersion?:string;
  closed?: boolean;
  id: string;
  seat: Seat;
  host: Seat;
  players: PublicPlayer[];
  roundNumber: number;
  round: RoundView | null;
  settlementPlayers?: Pick<PublicPlayer, 'seat' | 'name' | 'points'>[];
  deadline: number | null;
}

export interface ActionRequest { revision: number; action: Action }
export function seatWind(seat: Seat, banker: Seat, rulesVersion = 'wj-2'): Seat {
  return rulesVersion === 'wj-1' ? seat : ((seat - banker + 4) % 4) as Seat;
}
export const winds = ['东', '南', '西', '北'] as const;
export const roomType = 'mahjong';

export function tileLabel(tile: Tile): string {
  if (tile >= 27) return [...winds, '中', '发', '白'][tile - 27] ?? '？';
  return `${'一二三四五六七八九'[tile % 9]}${['万', '筒', '条'][Math.floor(tile / 9)]}`;
}

