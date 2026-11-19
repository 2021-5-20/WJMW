import type { Application, Request, Response, NextFunction } from 'express';
import { currentPlayer } from './auth.ts';
import { db } from './db.ts';
import { roomPreview } from './rooms.ts';

export async function initializeOperations() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS ops_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor uuid NOT NULL REFERENCES players,
      action text NOT NULL, target text, occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS service_incidents (
      reference uuid PRIMARY KEY, category text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function mountOperations(app: Application) {
  const authorize = async (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    const player = await currentPlayer(req);
    if (!player?.registered) { res.status(403).send('此页面需要管理员账号。'); return; }
    const allowed = await db().query('SELECT 1 FROM accounts a JOIN players p ON p.account_id=a.id WHERE p.id=$1 AND a.is_admin AND a.verified', [player.id]);
    if (!allowed.rowCount) { res.status(403).send('此页面需要管理员账号。'); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    await db().query('INSERT INTO ops_audit(actor,action,target) VALUES($1,$2,$3)', [player.id, 'overview', query || null]);
    res.locals.query = query;
    next();
  };
  app.get('/ops', authorize, async (_req, res) => {
    const query = res.locals.query as string;
    const overview = (await db().query(`SELECT count(*) FILTER (WHERE NOT (state->>'closed')::boolean) active,
      count(*) FILTER (WHERE (state->>'closed')::boolean) closed FROM game_rooms`)).rows[0];
    const archive = (await db().query('SELECT last_archived_time,last_failed_time FROM pg_stat_archiver')).rows[0];
    const time = (v: Date | null) => v ? v.toISOString() : '暂无记录';
    let details = '';
    if (query) {
      const room = await roomPreview(query);
      if (room) {
        const summary = (await db().query("SELECT state->'players' AS players FROM game_rooms WHERE id=$1", [query])).rows[0];
        const players = summary.players as {name: string; points: number}[];
        const rounds = (await db().query(`SELECT number,detail->'result'->>'source' AS source,
          detail->>'multiplier' AS multiplier, detail->'result'->'deltas' AS deltas
          FROM game_rounds WHERE room_id=$1 ORDER BY number DESC LIMIT 50`, [query])).rows;
        const sources: Record<string, string> = { selfDraw: '自摸', robKong: '抢杠胡', draw: '流局' };
        const phases: Record<string,string> = { waiting:'等待开局', playing:'对局中', settled:'等待续局', closed:'已散桌' };
        details = '<h2>房间 ' + escapeHtml(query) + '</h2><p>' + escapeHtml(phases[room.status]) +
          ' · ' + room.count + ' 人</p><ul>' + players.map(p => '<li>' + escapeHtml(p.name) + '　' + escapeHtml(p.points) + ' 分</li>').join('') + '</ul>';
        if (rounds.length) details += '<h3>最近结算</h3><ul>' + rounds.map(row =>
          '<li>第 ' + escapeHtml(row.number) + ' 局　' + escapeHtml(sources[row.source]) + '　×' +
          escapeHtml(row.multiplier) + '　' + escapeHtml(row.deltas.join(' / ')) + '</li>').join('') + '</ul>';
      } else {
        const found = (await db().query('SELECT category, occurred_at FROM service_incidents WHERE reference::text=$1', [query])).rows[0];
        details = found ? '<p>' + escapeHtml(found.occurred_at) + '　' + escapeHtml(found.category) + '</p>' : '<p>没有找到该记录。</p>';
      }
    }
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>吴江麻王 · 运营</title><main><h1>牌桌运营</h1><p>数据库已连接 · 活跃房间 ${escapeHtml(overview.active)} · 已结束 ${escapeHtml(overview.closed)}</p>
      <p>最近 WAL 归档　${escapeHtml(time(archive.last_archived_time))}<br>最近归档失败　${escapeHtml(time(archive.last_failed_time))}</p>
      <form><label>房间号或异常编号 <input name="q" maxlength="100" value="${escapeHtml(query)}"></label><button>查询</button></form>${details}<p><a href="/">回大厅</a></p></main></html>`);
  });
}
