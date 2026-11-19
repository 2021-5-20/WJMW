import { randomUUID, randomInt } from 'node:crypto';
import { matchMaker, Room, ServerError, type Client } from '@colyseus/core';
import { sessionEvents } from './session-control.ts';
import { db, transaction } from './db.ts';
import { initializeHistory } from './history.ts';
import {
  applyAction,
  createRound,
  remainingStreak,
  timeoutRound,
  viewRound,
  type RoundState,
} from '../shared/round.ts';
import {
  roomType,
  type Seat,
  type RoundResult,
  type RoomView,
  type ActionRequest,
} from '../shared/protocol.ts';

export interface Identity {
  id: string;
  name: string;
  avatar: number;
  registered: boolean;
}
interface Member extends Identity {
  expires?: number;
  seat: Seat;
  connected: boolean;
  ready: boolean;
  points: number;
}
interface Settlement {
  number: number;
  banker: Seat;
  dice: RoundState['dice'];
  joker: number;
  multiplier: number;
  streakRound: number;
  result: RoundResult;
}
interface Snapshot {
  players: Member[];
  round: RoundState | null;
  closed: boolean;
  rulesVersion: string;
  deadline: number | null;
  completed: number;
  revision: number;
  responseRevision: number;
}
const encode = (value: Snapshot) =>
  JSON.stringify(value, (_, v) => (v instanceof Map ? { mapEntries: [...v] } : v));
const decode = (value: string): Snapshot =>
  JSON.parse(value, (_, v) => (v?.mapEntries ? new Map(v.mapEntries) : v));
const grants = new Map<string, { id: string; state: Snapshot; version: number }>();
const live = new Map<string, MahjongRoom>();
async function open(id: string, state: Snapshot, version: number) {
  const key = randomUUID();
  grants.set(key, { id, state, version });
  try {
    return await matchMaker.createRoom(roomType, { key });
  } finally {
    grants.delete(key);
  }
}
export async function initializeRooms() {
  await db().query(
    'CREATE TABLE IF NOT EXISTS game_rooms(id text PRIMARY KEY, version integer NOT NULL, state jsonb NOT NULL)',
  );
  await db()
    .query(`CREATE TABLE IF NOT EXISTS game_rounds(room_id text NOT NULL REFERENCES game_rooms, number int NOT NULL, detail jsonb NOT NULL, settled_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(room_id,number));
    INSERT INTO game_rounds(room_id,number,detail) SELECT id,(r->>'number')::int,r FROM game_rooms CROSS JOIN LATERAL jsonb_array_elements(state->'rounds') r ON CONFLICT DO NOTHING;
    UPDATE game_rooms SET state=(state-'rounds') || jsonb_build_object('completed',jsonb_array_length(state->'rounds')) WHERE state ? 'rounds';`);
  await initializeHistory();
  const rows = await db().query("SELECT * FROM game_rooms WHERE (state->>'closed')::boolean=false");
  if (rows.rows.some(row => !['wj-1', 'wj-2'].includes(row.state.rulesVersion))) {
    throw new Error('存在当前服务无法恢复的规则版本，请使用兼容镜像。');
  }
  for (const row of rows.rows) await open(row.id, decode(JSON.stringify(row.state)), row.version);
}
const allocating = new Set<string>();
const boundClients = new Map<string, Set<Client>>();
sessionEvents.on('revoke', (keys) => {
  for (const key of keys)
    for (const c of boundClients.get(key) ?? []) {
      c.auth.revoked = true;
      void c.leave(4003);
    }
});
function validController(c: Client) {
  return !c.auth?.revoked && c.auth?.expires > Date.now();
}
async function sessionExpiry(key: string, id: string) {
  const row = (
    await db().query(
      `SELECT s.expires FROM auth_sessions s JOIN players owner ON owner.id=s.player_id
    JOIN players seat ON seat.id=$2 WHERE s.key=$1 AND s.expires>now() AND
    (seat.id=owner.id OR seat.account_id=owner.account_id)`,
      [key, id],
    )
  ).rows[0];
  if (!row) throw new ServerError(403, '请重新登录');
  return Number(row.expires);
}
export async function reserveRoom(
  { id, name, avatar, registered }: Identity,
  roomId: string | undefined,
  key: string,
) {
  await sessionExpiry(key, id);
  const player = { id, name, avatar, registered };
  if (
    avatar < 0 ||
    avatar > 3 ||
    !player.id ||
    !player.name.trim() ||
    [...player.name].length > 24 ||
    !Number.isInteger(player.avatar)
  )
    throw new Error('玩家资料无效');
  if (!roomId) {
    if (!player.registered) throw new Error('请先注册再开房');
    do {
      roomId = String(randomInt(100000000, 1000000000));
      if (allocating.has(roomId)) continue;
      allocating.add(roomId);
      try {
        if (!(await db().query('SELECT 1 FROM game_rooms WHERE id=$1', [roomId])).rowCount) break;
      } catch (error) {
        allocating.delete(roomId);
        throw error;
      }
      allocating.delete(roomId);
    } while (true);
    try {
      await open(
        roomId,
        {
          players: [{ ...player, seat: 0, points: 0, ready: false, connected: false }],
          round: null,
          closed: false,
          rulesVersion: 'wj-2',
          completed: 0,
          revision: 0,
          responseRevision: 0,
          deadline: null,
        },
        0,
      );
    } finally {
      allocating.delete(roomId);
    }
  }
  const room = live.get(roomId);
  if (!room) throw new Error('房间已结束或不存在');
  const ticket = await room.claim(player);
  return matchMaker.reserveSeatFor(
    await matchMaker.getRoomById(roomId),
    {},
    { playerId: player.id, ticket, key },
  );
}
export async function activeRoom(ids: string[]): Promise<string | null> {
  const rows = await db().query(
    "SELECT id FROM game_rooms WHERE (state->>'closed')::boolean=false AND EXISTS(SELECT 1 FROM jsonb_array_elements(state->'players') p WHERE p->>'id'=ANY($1::text[])) LIMIT 1",
    [ids],
  );
  return rows.rows[0]?.id ?? null;
}
export async function roomPreview(id: string) {
  const row = (await db().query('SELECT state FROM game_rooms WHERE id=$1', [id])).rows[0];
  if (!row) return null;
  const s = row.state as Snapshot;
  return {
    id,
    count: s.players.length,
    rulesVersion: s.rulesVersion,
    status: s.closed ? 'closed' : s.round?.result ? 'settled' : s.round ? 'playing' : 'waiting',
  };
}
export class MahjongRoom extends Room {
  autoDispose = false;
  private s!: Snapshot;
  private version = 0;
  private tickets = new Map<string, string>();
  private controllers = new Map<string, Client>();
  private queue = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  static async onAuth(): Promise<never> {
    throw new ServerError(403, '请通过房间邀请入座');
  }
  async onCreate(options: { key?: string }) {
    const grant = grants.get(options.key ?? '');
    if (!grant) throw new ServerError(403, '无效房间凭证');
    grants.delete(options.key!);
    this.roomId = grant.id;
    await this.setPrivate(true);
    this.s = grant.state;
    if (this.s.round) this.s.round.rulesVersion = this.s.rulesVersion;
    this.version = grant.version;
    for (const p of this.s.players) {
      p.connected = false;
      p.expires = Date.now() + 120_000;
    }
    this.resetDeadline();
    await this.save(grant.version === 0 ? this.s.players[0].id : undefined);
    live.set(this.roomId, this);
    this.schedule();
    this.onMessage('sync', (c) => this.enqueue(() => this.view(c)));
    for (const type of ['start', 'ready', 'action', 'leave'])
      this.onMessage(type, (c, data) =>
        this.change(() => this.command(c, type, data)).catch((e) =>
          c.send(
            'notice',
            e instanceof Error && /^[\u3400-\u9fff]/u.test(e.message)
              ? e.message
              : '暂时无法保存，请稍后重试。',
          ),
        ),
      );
  }
  private enqueue<T>(fn: () => Promise<T> | T) {
    const task = this.queue.then(fn);
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async save(checkMember?: string, settlement?: Settlement) {
    const data = encode(this.s);
    try {
      await transaction(async (client) => {
        if (checkMember) {
          await client.query('SELECT pg_advisory_xact_lock(716424)');
          const identity = await client.query('SELECT account_id FROM players WHERE id=$1', [checkMember]);
          if (!identity.rowCount || (!this.version && !identity.rows[0].account_id))
            throw new Error('请先注册再开房');
          const conflict = await client.query(
            "SELECT 1 FROM game_rooms g CROSS JOIN LATERAL jsonb_array_elements(g.state->'players') p JOIN players member ON member.id=(p->>'id')::uuid JOIN players candidate ON candidate.id=$1 WHERE (g.id<>$2 OR member.id<>candidate.id) AND (g.state->>'closed')::boolean=false AND (member.id=candidate.id OR member.account_id=candidate.account_id) LIMIT 1",
            [checkMember, this.roomId],
          );
          if (conflict.rowCount) throw new Error('玩家已在另一桌');
        }
        const result =
          this.version === 0
            ? await client.query('INSERT INTO game_rooms(id,state,version) VALUES($1,$2,1)', [
                this.roomId,
                data,
              ])
            : await client.query(
                'UPDATE game_rooms SET state=$2, version=version+1 WHERE id=$1 AND version=$3',
                [this.roomId, data, this.version],
              );
        if (settlement) {
          await client.query('INSERT INTO game_rounds(room_id,number,detail) VALUES($1,$2,$3)', [
            this.roomId,
            settlement.number,
            settlement,
          ]);
          if (settlement.number === 1) await client.query(
            'INSERT INTO history_players(player_id,room_id) SELECT unnest($1::uuid[]),$2',
            [this.s.players.map(p => p.id), this.roomId]);
        }
        if (result.rowCount !== 1) throw new Error('房间状态冲突');
      });
    } catch (error) {
      // A lost COMMIT acknowledgement is safe to accept only for this exact next snapshot.
      const saved = await db().query(
        'SELECT 1 FROM game_rooms WHERE id=$1 AND version=$2 AND state=$3::jsonb',
        [this.roomId, this.version + 1, data],
      );
      if (!saved.rowCount) throw error;
    }
    this.version++;
  }
  private change(fn: () => void, checkMember?: string) {
    return this.enqueue(async () => {
      const completed = this.s.completed;
      const before = encode(this.s);
      const oldControllers = new Map(this.controllers);
      try {
        fn();
        const round = this.s.round;
        const settlement =
          round?.result && this.s.completed > completed
            ? {
                number: this.s.completed,
                banker: round.banker,
                dice: round.dice,
                joker: round.joker,
                multiplier: round.bonus.multiplier,
                streakRound: round.bonus.streakRound,
                result: round.result,
              }
            : undefined;
        await this.save(checkMember, settlement);
      } catch (e) {
        this.s = decode(before);
        this.controllers = oldControllers;
        this.schedule();
        throw e;
      }
      for (const c of this.clients) this.view(c);
      if (this.s.closed) this.autoDispose = true;
      this.schedule();
    });
  }
  async claim(identity: Identity) {
    await this.change(() => {
      if (this.s.closed) throw new Error('房间已结束');
      const existing = this.s.players.find((p) => p.id === identity.id);
      if (existing) {
        if (!this.s.round) {
          existing.name = identity.name;
          existing.avatar = identity.avatar;
        }
        if (!existing.connected) existing.expires = Date.now() + 120_000;
        return;
      }
      if (this.s.players.length >= 4 || this.s.round) throw new Error('房间已满');
      this.s.players.push({
        ...identity,
        expires: Date.now() + 120_000,
        seat: ([0, 1, 2, 3] as Seat[]).find((seat) => !this.s.players.some((p) => p.seat === seat))!,
        points: 0,
        ready: false,
        connected: false,
      });
      this.s.players.sort((a, b) => a.seat - b.seat);
    }, identity.id);
    const ticket = randomUUID();
    this.tickets.set(identity.id, ticket);
    return ticket;
  }
  async onJoin(c: Client) {
    const id = c.auth?.playerId;
    const key = c.auth?.key;
    if (!key) throw new ServerError(403, '请重新登录');
    const clients = boundClients.get(key) ?? new Set<Client>();
    clients.add(c);
    boundClients.set(key, clients);
    c.auth.expires = await sessionExpiry(key, id);
    const expire = () => {
      if (c.auth.expires > Date.now())
        c.auth.timer = setTimeout(expire, Math.min(2147483647, c.auth.expires - Date.now()));
      else {
        c.auth.revoked = true;
        void c.leave(4003);
      }
    };
    expire();
    let old: Client | undefined;
    await this.change(() => {
      const p = this.s.players.find((p) => p.id === id);
      if (!validController(c) || !p || this.s.closed || this.tickets.get(id) !== c.auth.ticket)
        throw new ServerError(403, '座位无效');
      this.tickets.delete(id);
      old = this.controllers.get(id);
      this.controllers.set(id, c);
      p.connected = true;
      delete p.expires;
    });
    if (old && old !== c) void old.leave(4001);
  }
  async onLeave(c: Client) {
    if (c.auth) {
      clearTimeout(c.auth.timer);
      const bound = boundClients.get(c.auth.key);
      bound?.delete(c);
      if (bound?.size === 0) boundClients.delete(c.auth.key);
    }
    let delay = 250;
    while (this.controllers.get(c.auth?.playerId) === c) {
      try {
        await this.change(() => {
          if (this.controllers.get(c.auth?.playerId) !== c) return;
          this.controllers.delete(c.auth.playerId);
          const p = this.s.players.find((p) => p.id === c.auth.playerId)!;
          p.connected = false;
          p.expires = Date.now() + 120_000;
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(10000, delay * 2);
      }
    }
  }
  onDispose() {
    clearTimeout(this.timer);
    live.delete(this.roomId);
  }
  private command(c: Client, type: string, data: ActionRequest) {
    const p = this.s.players.find((p) => p.id === c.auth.playerId);
    if (!validController(c) || !p || this.controllers.get(p.id) !== c || this.s.closed) return;
    const r = this.s.round;
    if (type === 'leave') {
      if (!r || r.result) this.s.closed = true;
      else {
        void c.leave(4000);
      }
    } else if (type === 'start' || type === 'ready') {
      if (type === 'start' && (r || p.seat !== 0)) throw new Error('请等待房主开局。');
      if (type === 'ready') {
        if (!r?.result) return;
        p.ready = true;
      }
      if (this.s.players.length !== 4 || this.s.players.some((p) => !p.connected))
        throw new Error('等四位牌友入座后再开局。');
      if (type === 'ready' && this.s.players.some((p) => !p.ready)) return;
      this.s.round = createRound(r?.result?.winner ?? r?.banker ?? 0, remainingStreak(r), {
        randomInt,
        rulesVersion: this.s.rulesVersion,
      });
      this.s.players.forEach((p) => (p.ready = false));
      this.advance();
    } else if (r && !r.result) {
      if (
        !data ||
        !Number.isSafeInteger(data.revision) ||
        data.revision > this.s.revision ||
        data.revision < (r.pending ? this.s.responseRevision : this.s.revision)
      )
        throw new Error('牌局已更新，请重新操作。');
      const action = data.action;
      if (
        !action ||
        typeof action !== 'object' ||
        !['pass', 'hu', 'discard', 'pong', 'openKong', 'closedKong', 'addedKong'].includes(action.type) ||
        (action.tile !== undefined && (!Number.isInteger(action.tile) || action.tile < 0 || action.tile > 33))
      )
        throw new Error('无法识别这次操作。');
      const pending = r.pending;
      applyAction(
        r,
        p.seat,
        action.tile === undefined ? { type: action.type } : { type: action.type, tile: action.tile },
      );
      this.advance(!!pending && pending === r.pending);
    }
  }
  private advance(same = false) {
    const r = this.s.round!;
    this.s.revision++;
    if (!same) {
      this.s.responseRevision = this.s.revision;
      this.resetDeadline();
    }
    if (r.result) {
      r.result.deltas.forEach((delta, i) => (this.s.players[i].points += delta));
      this.s.completed++;
      if (this.s.players.some((p) => !p.connected)) this.s.closed = true;
    }
  }
  private resetDeadline() {
    const r = this.s.round;
    this.s.deadline = r && !r.result ? Date.now() + (r.pending ? 10_000 : 35_000) : null;
  }
  private schedule(minDelay = 50) {
    clearTimeout(this.timer);
    if (this.s.closed) return;
    const playing = this.s.round && !this.s.round.result;
    const expiredAt = (p: Member) => p.expires ?? Infinity;
    const deadline = playing
      ? this.s.deadline
      : Math.min(...this.s.players.filter((p) => !p.connected).map(expiredAt));
    if (!deadline || !Number.isFinite(deadline)) return;
    this.timer = setTimeout(
      () => {
        void this.change(() => {
          if (this.s.closed) return;
          if (playing) {
            if (this.s.deadline !== deadline || !this.s.round || this.s.round.result) return;
            timeoutRound(this.s.round);
            this.advance();
            return;
          }
          const expired = this.s.players.filter((p) => !p.connected && expiredAt(p) <= Date.now());
          if (!expired.length) return;
          if (this.s.round || expired.some((p) => p.seat === 0)) this.s.closed = true;
          else {
            for (const p of expired) this.tickets.delete(p.id);
            this.s.players = this.s.players.filter((p) => !expired.includes(p));
          }
        }).catch(() => this.schedule(2000));
      },
      Math.max(minDelay, deadline - Date.now()),
    );
  }
  private view(c: Client) {
    const p = this.s.players.find((p) => p.id === c.auth?.playerId);
    if (!validController(c) || !p || this.controllers.get(p.id) !== c) return;
    const round = this.s.round && viewRound(this.s.round, p.seat);
    if (round) round.revision = this.s.revision;
    const players = this.s.players.map(({ id, registered, expires, ...p }) => ({
      ...p,
      ...round?.players[p.seat],
      handCount: round?.players[p.seat].handCount ?? 0,
      melds: round?.players[p.seat].melds ?? [],
      discards: round?.players[p.seat].discards ?? [],
    }));
    const view: RoomView = {
      id: this.roomId,
      rulesVersion: this.s.rulesVersion,
      closed: this.s.closed,
      players,
      seat: p.seat,
      host: 0,
      round,
      roundNumber: this.s.completed + (round && !round.result ? 1 : 0),
      deadline: this.s.deadline,
      settlementPlayers: round?.result ? players : undefined,
    };
    c.send('view', view);
  }
}
