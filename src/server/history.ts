import { db, transaction } from './db.ts';
import type { RoundResult, Seat } from '../shared/protocol.ts';

interface HistoryPlayer { name: string; seat: Seat; points: number }
interface HistoryRound {
  number: number; banker: Seat; dice: [number, number]; joker: number;
  multiplier: number; streakRound: number; result: RoundResult;
}
interface HistoryRow {
  id: string; closed: boolean; version: string; players: HistoryPlayer[];
  rounds: HistoryRound[]; last_settlement: string;
}

export async function initializeHistory() {
  await transaction(async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS history_players (player_id uuid NOT NULL,
        room_id text NOT NULL REFERENCES game_rooms ON DELETE CASCADE, PRIMARY KEY(player_id,room_id));
      CREATE INDEX IF NOT EXISTS game_rooms_active ON game_rooms(id) WHERE (state->>'closed')::boolean=false;`);
    const applied = await client.query("INSERT INTO schema_migrations VALUES('indexed_history_v1') ON CONFLICT DO NOTHING RETURNING name");
    if (applied.rowCount) await client.query(`INSERT INTO history_players(player_id, room_id)
      SELECT (p->>'id')::uuid,g.id FROM game_rooms g CROSS JOIN LATERAL jsonb_array_elements(g.state->'players') p
      WHERE EXISTS (SELECT 1 FROM game_rounds r WHERE r.room_id=g.id) ON CONFLICT DO NOTHING`);
  });
}

export function readHistoryCursor(raw: unknown): [string, string] | null {
  if (raw === undefined) return null;
  if (typeof raw === 'string' && raw.length <= 256) {
    try {
      const pair: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(pair[0]) &&
          Number.isFinite(Date.parse(pair[0])) && typeof pair[1] === 'string' && /^[\w-]{1,64}$/.test(pair[1])) {
        return [pair[0], pair[1]];
      }
    } catch { /* Invalid cursor is a client input error. */ }
  }
  throw new Error('战绩分页参数无效');
}

export async function historyPage(ids: string[], before: [string, string] | null = null) {
  const { rows } = await db().query<HistoryRow>(`
    WITH candidates AS (
      SELECT DISTINCT room_id FROM history_players WHERE player_id=ANY($1::uuid[])
    ), page AS (
      SELECT c.room_id, latest.settled_at FROM candidates c CROSS JOIN LATERAL
        (SELECT settled_at FROM game_rounds WHERE room_id=c.room_id ORDER BY number DESC LIMIT 1) latest
      WHERE $2::timestamptz IS NULL OR (latest.settled_at,c.room_id) < ($2::timestamptz,$3::text)
      ORDER BY latest.settled_at DESC,c.room_id DESC LIMIT 51
    ) SELECT g.id,g.state->'players' players,(g.state->>'closed')::boolean closed,g.state->>'rulesVersion' version,
        to_char(page.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') last_settlement,
        (SELECT jsonb_agg(r.detail ORDER BY r.number) FROM game_rounds r WHERE r.room_id=g.id) rounds
      FROM page JOIN game_rooms g ON g.id=page.room_id ORDER BY page.settled_at DESC,g.id DESC`,
    [ids, before?.[0] ?? null, before?.[1] ?? null]);
  const matches = rows.slice(0, 50).map(row => ({
    id: row.id, closed: row.closed, rulesVersion: row.version, rounds: row.rounds,
    players: row.players.map(({ seat, name, points }) => ({ seat, name, points })),
  }));
  const nextCursor = rows.length > 50
    ? Buffer.from(JSON.stringify([rows[49].last_settlement, rows[49].id])).toString('base64url') : null;
  return { matches, nextCursor };
}

export async function historyFor(ids: string[]) {
  return (await historyPage(ids)).matches;
}
