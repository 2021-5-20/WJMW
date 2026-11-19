import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startMahjongServer } from '../src/server/app.ts';
import { db } from '../src/server/db.ts';
import { isolateDatabase } from './fixtures/isolated-db.ts';

test('authenticated HTTP history pages, room authorization and audited operator lookup', { skip: isolateDatabase() }, async t => {
  const app = await startMahjongServer({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  async function post(path: string, cookie = '', origin = app.url) {
    return fetch(app.url + path, { method: 'POST', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: '{}' });
  }
  assert.equal((await post('/api/auth/guest', '', 'https://another.example')).status, 403);
  assert.equal((await post('/api/rooms')).status, 401);
  const guest = await post('/api/auth/guest');
  const cookie = guest.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post('/api/rooms', cookie)).status, 403);
  const headers = { cookie };
  const me = await (await fetch(app.url + '/api/me', { headers })).json();
  const playerId = me.player.id;
  assert.equal(me.activeRoom, null);
  assert.equal((await fetch(app.url + '/ops', { headers })).status, 403);
  assert.equal((await fetch(app.url + '/api/history?cursor=bad', { headers })).status, 400);

  const account = (await db().query('INSERT INTO accounts(username,password_hash,primary_player) VALUES ($1,$2,$3) RETURNING id',
    [randomUUID(), 'unusable-qa-hash', playerId])).rows[0].id;
  await db().query('UPDATE players SET account_id=$1 WHERE id=$2', [account, playerId]);
  const roster = [{ id: playerId, name: '旧昵称', seat: 0, points: 0 }];
  const state = { closed: true, completed: 1, rulesVersion: 'wj-2', players: roster, round: null };
  await db().query("INSERT INTO game_rooms(id,version,state) SELECT 'history-'||n,1,$1 FROM generate_series(1,52) n", [state]);
  await db().query(`INSERT INTO game_rounds(room_id,number,detail,settled_at)
    SELECT id,1,'{"number":1,"result":{"source":"draw","deltas":[0,0,0,0]}}','2026-01-01T00:00:00Z'
    FROM game_rooms`);
  await db().query('INSERT INTO history_players SELECT $1,id FROM game_rooms WHERE id<>$2', [playerId, 'history-52']);
  const page = await (await fetch(app.url + '/api/history', { headers })).json();
  assert.equal(page.matches.length, 50);
  assert.ok(page.nextCursor);
  const end = await (await fetch(app.url + '/api/history?cursor=' + page.nextCursor, { headers })).json();
  assert.equal(end.matches.length, 1);
  assert.equal(end.nextCursor, null);
  const seen = new Set([...page.matches, ...end.matches].map(match => match.id));
  assert.equal(seen.size, 51);
  assert.ok(!seen.has('history-52'));
  assert.deepEqual(end.matches[0].players, [{name:'旧昵称',seat:0,points:0}]);

  await db().query('UPDATE accounts SET is_admin=true WHERE id=$1', [account]);
  assert.equal((await fetch(app.url + '/ops', { headers })).status, 403);
  await db().query('UPDATE accounts SET verified=true WHERE id=$1', [account]);
  const ops = await fetch(app.url + '/ops?q=history-1', { headers });
  assert.equal(ops.status, 200);
  assert.match(await ops.text(), /最近结算/);
  assert.equal((await db().query('SELECT actor FROM ops_audit WHERE target=$1', ['history-1'])).rows[0].actor, playerId);
});
