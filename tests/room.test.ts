import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type Room } from '@colyseus/sdk';
import { startMahjongServer } from '../src/server/app.ts';
import { db } from '../src/server/db.ts';
import { activeRoom, historyFor, roomPreview, reserveRoom } from '../src/server/rooms.ts';
import { randomUUID } from 'node:crypto';
import { roomType, type Action, type RoomView } from '../src/shared/protocol.ts';
import { isolateDatabase } from './fixtures/isolated-db.ts';

const skip = isolateDatabase();

function observe(room: Room) {
  let latest: RoomView | undefined;
  const waiters = new Set<(view: RoomView) => void>();
  room.onMessage<RoomView>('view', (view) => {
    latest = view;
    for (const wait of waiters) wait(view);
  });
  return (matches: (view: RoomView) => boolean) =>
    new Promise<RoomView>((resolve, reject) => {
      if (latest && matches(latest)) return resolve(latest);
      const listener = (view: RoomView) => {
        if (!matches(view)) return;
        clearTimeout(timer);
        waiters.delete(listener);
        resolve(view);
      };
      const timer = setTimeout(() => {
        waiters.delete(listener);
        reject(new Error('Timed out waiting for room view'));
      }, 3000);
      waiters.add(listener);
    });
}

function notice(room: Room) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected a room notice')), 3000);
    const off = room.onMessage<string>('notice', (text) => {
      off();
      clearTimeout(timer);
      resolve(text);
    });
  });
}

test(
  'four private seats reconnect and advance through settlement to a second deal',
  { timeout: 30000, skip },
  async (t) => {
    const server = await startMahjongServer({ host: '127.0.0.1', port: 0 });
    t.after(() => server.close());
    const sdk = new Client(server.url);
    const people = ['阿东', '阿南', '阿西', '阿北', '候补'].map((name) => ({
      id: randomUUID(),
      name,
      avatar: 0,
      registered: name === '阿东',
    }));
    for (const p of people)
      await db().query('INSERT INTO players(id,name,avatar) VALUES($1,$2,$3)', [p.id, p.name, p.avatar]);
    const secrets = people.map(() => randomBytes(32).toString('hex'));
    const keys = secrets.map((value) => createHash('sha256').update(value).digest('hex'));
    for (const [i, p] of people.entries())
      await db().query(
        "INSERT INTO auth_sessions(key,player_id,expires) VALUES($1,$2,now()+interval '1 hour')",
        [keys[i], p.id],
      );
    const account = await db().query(
      'INSERT INTO accounts(username,password_hash) VALUES($1,$2) RETURNING id',
      [randomUUID(), 'test'],
    );
    await db().query('UPDATE players SET account_id=$1 WHERE id=$2', [account.rows[0].id, people[0].id]);
    await assert.rejects(sdk.create(roomType, {}));
    const join = async (i: number, id?: string) =>
      sdk.consumeSeatReservation(await reserveRoom(people[i], id, keys[i]));
    const host = await join(0);
    assert.match(host.roomId, /^\d{9}$/);
    t.after(async () => {
      await db().query('DELETE FROM game_rounds WHERE room_id=$1', [host.roomId]);
      await db().query('DELETE FROM game_rooms WHERE id=$1', [host.roomId]);
      await db().query('DELETE FROM auth_sessions WHERE player_id=ANY($1::uuid[])', [
        people.map((p) => p.id),
      ]);
      await db().query('DELETE FROM players WHERE id=ANY($1::uuid[])', [people.map((p) => p.id)]);
      await db().query('DELETE FROM accounts WHERE id=$1', [account.rows[0].id]);
    });
    const rooms: Room[] = [host];
    const views = [observe(host)];
    for (const i of [1, 2, 3]) {
      const room = await join(i, host.roomId);
      rooms.push(room);
      views.push(observe(room));
    }
    rooms.forEach((room) => room.send('sync'));
    const lobby = await Promise.all(views.map((read) => read((view) => view.players.length === 4)));
    assert.deepEqual(
      lobby.map((view) => view.seat),
      [0, 1, 2, 3],
    );

    const startError = notice(rooms[1]);
    rooms[1].send('start');
    assert.match(await startError, /房主/);
    host.send('start');
    const open = await Promise.all(views.map((read) => read((view) => view.roundNumber === 1)));
    assert.deepEqual(
      open.map((view) => view.round?.hand.length),
      [14, 13, 13, 13],
    );
    for (const view of open) {
      assert.ok(view.round);
      for (const player of view.round.players) assert.equal('hand' in player, false);
      assert.equal('wall' in view.round, false);
    }

    assert.equal(await activeRoom([people[1].id]), host.roomId);
    const beforeDrop = open[1].round?.hand;
    await assert.rejects(join(4, host.roomId));
    rooms[1].reconnection.enabled = false;
    await rooms[1].leave(false);
    await views[0]((view) => view.players[1]?.connected === false);
    rooms[1] = await join(1, host.roomId);
    views[1] = observe(rooms[1]);
    rooms[1].send('sync');
    const resumed = await views[1]((view) => view.players[1]?.connected === true);
    assert.equal(resumed.seat, 1);
    assert.deepEqual(resumed.round?.hand, beforeDrop);

    const revoked = await reserveRoom(people[1], host.roomId, keys[1]);
    const takeover = new Promise<number>((resolve) => rooms[1].onLeave(resolve));
    rooms[1] = await join(1, host.roomId);
    assert.equal(await takeover, 4001);
    views[1] = observe(rooms[1]);
    rooms[1].send('sync');
    await assert.rejects(sdk.consumeSeatReservation(revoked));
    assert.deepEqual((await views[1]((v) => v.seat === 1)).round?.hand, beforeDrop);

    const first = open[0].round!;
    const invalid = notice(host);
    host.send('action', { revision: first.revision, action: { type: 'discard', tile: -1 } });
    assert.match(await invalid, /识别/);
    const discard = first.actions.find((action) => action.type === 'discard');
    assert.ok(discard);
    host.send('action', { revision: first.revision, action: discard });
    await views[0]((view) => (view.round?.revision ?? 0) > first.revision);
    const stale = notice(host);
    host.send('action', { revision: first.revision, action: discard });
    assert.match(await stale, /更新/);

    let current = await Promise.all(
      views.map((read) => read((view) => (view.round?.revision ?? 0) > first.revision)),
    );
    for (let step = 0; current[0].round?.phase !== 'settled' && step < 180; step++) {
      const revision = current[0].round!.revision;
      const choice = current.map((view) =>
        view.round?.actions.find((action) => action.type === 'discard' || action.type === 'pass'),
      );
      const seat = choice.findIndex(Boolean);
      assert.ok(seat >= 0, 'an active round must expose a legal action');
      rooms[seat].send('action', { revision, action: choice[seat] as Action });
      current = await Promise.all(
        views.map((read) => read((view) => (view.round?.revision ?? 0) > revision)),
      );
    }
    assert.equal(current[0].round?.phase, 'settled');
    assert.equal(current[0].round?.result?.source, 'draw');
    const history = await historyFor([people[1].id]);
    assert.equal(history[0].rounds.length, 1);
    assert.deepEqual(history[0].rounds[0].result, current[0].round?.result);
    assert.equal((await roomPreview(host.roomId))?.count, 4);
    rooms.forEach((room) => room.send('ready'));
    const next = await Promise.all(views.map((read) => read((view) => view.roundNumber === 2)));
    assert.deepEqual(
      next.map((view) => view.round?.hand.length),
      [14, 13, 13, 13],
    );
    assert.ok(next[0].round!.revision > current[0].round!.revision);
    for (const [i, action] of [
      [1, 'logout'],
      [0, 'reset'],
    ] as const) {
      const pending = await reserveRoom(people[i], host.roomId, keys[i]);
      const left = new Promise<number>((resolve) => rooms[i].onLeave(resolve));
      const token = randomBytes(32).toString('hex');
      if (action === 'reset')
        await db().query(
          "INSERT INTO auth_tokens(key,account_id,purpose,expires) VALUES($1,$2,'reset',now()+interval '1 hour')",
          [createHash('sha256').update(token).digest('hex'), account.rows[0].id],
        );
      const response = await fetch(server.url + '/api/auth/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'wj_session=' + secrets[i] },
        body: JSON.stringify({ token, password: 'NewPassword1234' }),
      });
      assert.ok(response.ok, await response.text());
      assert.equal(await left, 4003);
      await assert.rejects(sdk.consumeSeatReservation(pending));
    }
  },
);
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRound, timeoutRound, viewRound } from '../src/shared/round.ts';

test('a failed settlement remains playable and an offline seat is settled exactly once by timeout',
  { skip, timeout: 52000 }, async t => {
    const setup = await startMahjongServer({ host: '127.0.0.1', port: 0 });
    await setup.close();
    let round = createRound(0, 2);
    // Use a legal final discard which exhausts the wall without an intervening claim.
    for (;;) {
      round.wall = [];
      const final = structuredClone(round);
      timeoutRound(final);
      if (final.result?.source === 'draw') break;
      round = createRound(0, 2);
    }
    const id = randomUUID();
    const members = [];
    const keys = [];
    for (const seat of [0, 1, 2, 3] as const) {
      const player = { id: randomUUID(), seat, registered: false, name: '牌友' + seat,
        avatar: seat, connected: true, ready: false, points: seat - 2 };
      const key = createHash('sha256').update(randomBytes(32)).digest('hex');
      members.push(player);
      keys.push(key);
      await db().query('INSERT INTO players(id,name,avatar) VALUES($1,$2,$3)', [player.id, player.name, seat]);
      await db().query("INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 hour')", [key, player.id]);
    }
    await db().query('INSERT INTO game_rooms(id,version,state) VALUES($1,1,$2)', [id,
      { closed:false, players:members, round, rulesVersion:'wj-2', completed:0, revision:12, responseRevision:12, deadline:0 }]);
    const server = await startMahjongServer({ host:'127.0.0.1', port:0 });
    t.after(() => server.close());
    const sdk = new Client(server.url);
    const actor = await sdk.consumeSeatReservation(await reserveRoom(members[0], id, keys[0]));
    actor.reconnection.enabled = false;
    const witness = await sdk.consumeSeatReservation(await reserveRoom(members[1], id, keys[1]));
    const read = observe(witness);
    witness.send('sync');
    await read(v => v.players[1].connected && !v.players[3].connected);
    const original = (await db().query('SELECT state,version FROM game_rooms WHERE id=$1', [id])).rows[0];
    await db().query(`CREATE FUNCTION reject_settlement() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'temporary QA write failure'; END $$;
      CREATE TRIGGER pause_settlement BEFORE INSERT ON game_rounds FOR EACH ROW EXECUTE FUNCTION reject_settlement()`);
    const failed = notice(actor);
    actor.send('action', { revision:12, action:{type:'discard',tile:round.drawnTile} });
    assert.match(await failed, /保存/);
    assert.deepEqual((await db().query('SELECT state,version FROM game_rooms WHERE id=$1', [id])).rows[0], original);
    assert.deepEqual(await historyFor([members[1].id]), []);
    await actor.leave(false);
    await read(v => !v.players[0].connected && !v.round?.result);
    await db().query('DROP TRIGGER pause_settlement ON game_rounds');
    const final = await new Promise<RoomView>((resolve,reject) => {
      const guard = setTimeout(() => reject(new Error('offline timeout did not close room')), 42000);
      witness.onMessage<RoomView>('view', v => { if (v.closed && v.round?.result) { clearTimeout(guard); resolve(v); } });
    });
    assert.equal(final.round?.result?.source, 'draw');
    assert.deepEqual(final.players.map(p => p.points), members.map(p => p.points));
    assert.deepEqual(final.players.map(p => p.name), members.map(p => p.name));
    assert.equal(await activeRoom([members[1].id]), null);
    assert.equal((await historyFor([members[1].id]))[0].rounds.length, 1);
  });

for (const rulesVersion of ['wj-1', 'wj-2'])
  test(
    rulesVersion + ' process death restores pending responses and commits a settlement only once',
    { timeout: 30000, skip },
    async (t) => {
      const setup = await startMahjongServer({ host: '127.0.0.1', port: 0 });
      await setup.close();
      const roomId = randomUUID();
      const cookies: string[] = [];
      const players: {
        id: string;
        name: string;
        avatar: number;
        registered: boolean;
        seat: 0 | 1 | 2 | 3;
        connected: boolean;
        ready: boolean;
        points: number;
      }[] = [];
      // Capture a real response phase; this fixture is inserted as a previously committed snapshot.
      let round = createRound(2, 2, { rulesVersion, dice: [1, 2] });
      for (let i = 0; !round.pending; i++) {
        if (i > 2000) throw new Error('No pending response fixture');
        if (round.result) round = createRound(2, 2, { rulesVersion, dice: [1, 2] });
        timeoutRound(round);
      }
      for (const seat of [0, 1, 2, 3] as const) {
        const cookie = randomBytes(32).toString('hex');
        cookies.push('wj_session=' + cookie);
        const p = {
          id: randomUUID(),
          name: '恢复' + seat,
          avatar: seat,
          registered: false,
          seat,
          connected: true,
          ready: false,
          points: 0,
        };
        players.push(p);
        await db().query('INSERT INTO players(id,name,avatar) VALUES($1,$2,$3)', [p.id, p.name, p.avatar]);
        await db().query(
          "INSERT INTO auth_sessions(key,player_id,expires) VALUES($1,$2,now()+interval '1 hour')",
          [createHash('sha256').update(cookie).digest('hex'), p.id],
        );
      }
      if (rulesVersion === 'wj-1') delete round.rulesVersion;
      const state = {
        players,
        round,
        closed: false,
        rulesVersion,
        completed: 0,
        revision: 12,
        responseRevision: 12,
        deadline: Date.now() - 5000,
      };
      await db().query('INSERT INTO game_rooms(id,version,state) VALUES($1,1,$2)', [
        roomId,
        JSON.stringify(state, (_, v) => (v instanceof Map ? { mapEntries: [...v] } : v)),
      ]);
      let child: ChildProcess | undefined;
      let url = '';
      let rooms: Room[] = [];
      let reads: ReturnType<typeof observe>[] = [];
      async function kill() {
        if (!child) return;
        const done = once(child, 'exit');
        child.kill('SIGKILL');
        await done;
        child = undefined;
      }
      t.after(async () => {
        await kill();
        const ids = players.map((p) => p.id);
        await db().query('DELETE FROM game_rounds WHERE room_id=$1', [roomId]);
        await db().query('DELETE FROM game_rooms WHERE id=$1', [roomId]);
        await db().query('DELETE FROM auth_sessions WHERE player_id=ANY($1::uuid[])', [ids]);
        await db().query('DELETE FROM players WHERE id=ANY($1::uuid[])', [ids]);
      });
      async function boot() {
        child = fork(new URL('./fixtures/room-server.ts', import.meta.url), [], {
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        [url] = await Promise.race([
          once(child, 'message'),
          once(child, 'exit').then(() => {
            throw new Error('server exited');
          }),
        ]);
        rooms = [];
        reads = [];
        const sdk = new Client(url);
        for (const cookie of cookies) {
          const response = await fetch(url + '/api/rooms/' + roomId + '/seat', {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: '{}',
          });
          assert.equal(response.status, 200);
          const room = await sdk.consumeSeatReservation(await response.json());
          room.reconnection.enabled = false;
          rooms.push(room);
          reads.push(observe(room));
          room.send('sync');
        }
        return Promise.all(reads.map((read) => read((v) => v.players.every((p) => p.connected))));
      }
      let views = await boot();
      for (const p of players) {
        assert.deepEqual(views[p.seat].round?.actions, viewRound(round, p.seat).actions);
        assert.ok(views[p.seat].deadline! > Date.now());
      }
      const oldReservation = await (
        await fetch(url + '/api/rooms/' + roomId + '/seat', {
          method: 'POST',
          headers: { Cookie: cookies[0], 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).json();
      const seat = views.findIndex((v) => v.round?.actions.some((a) => a.type === 'pass'));
      rooms[seat].send('action', { revision: 12, action: { type: 'pass' } });
      views = await Promise.all(reads.map((read) => read((v) => v.round!.revision === 13)));
      const saved = views.map((v) => v.round);
      await kill();
      views = await boot();
      assert.deepEqual(
        views.map((v) => v.round),
        saved,
      );
      await assert.rejects(new Client(url).consumeSeatReservation(oldReservation));
      const duplicate = notice(rooms[seat]);
      rooms[seat].send('action', { revision: 12, action: { type: 'pass' } });
      assert.ok(await duplicate);
      while (!views[0].round?.result) {
        const revision = views[0].round!.revision;
        const actions = views.map((v) =>
          v.round!.actions.find((a) => a.type === 'pass' || a.type === 'discard'),
        );
        const i = actions.findIndex(Boolean);
        assert.ok(i >= 0);
        rooms[i].send('action', { revision, action: actions[i] });
        views = await Promise.all(reads.map((read) => read((v) => v.round!.revision > revision)));
      }
      const settled = views[0].round;
      assert.equal(views[0].rulesVersion, rulesVersion);
      await kill();
      views = await boot();
      assert.deepEqual(views[0].round, settled);
      assert.equal((await historyFor([players[0].id]))[0].rounds.length, 1);
      assert.equal((await historyFor([players[0].id]))[0].rulesVersion, rulesVersion);
      rooms.forEach((room) => room.send('ready'));
      const next = await reads[0]((v) => v.roundNumber === 2);
      assert.equal(next.rulesVersion, rulesVersion);
      if (next.round!.dice[0] !== next.round!.dice[1] || next.round!.joker < 27)
        assert.equal(next.round!.streakRound, rulesVersion === 'wj-1' ? 3 : 2);
    },
  );
