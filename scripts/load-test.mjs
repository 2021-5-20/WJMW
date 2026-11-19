import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@colyseus/sdk";
import pg from "pg";
import { startMahjongServer } from "../src/server/app.ts";
import { db } from "../src/server/db.ts";

const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, "127.0.0.1");
assert.equal(target.pathname, "/mawang_load");
const tables = Number(process.env.LOAD_TABLES ?? 100);
const duration = Number(process.env.LOAD_SECONDS ?? 3600);
const pace = Number(process.env.LOAD_INTERVAL_MS ?? 1000);
assert.ok(Number.isInteger(tables) && tables >= 1 && tables <= 100);
assert.ok(Number.isFinite(duration) && duration >= 1 && duration <= 3600);
assert.ok(Number.isFinite(pace) && pace >= 100);
const schema = "load_" + randomBytes(8).toString("hex");
const bootstrap = new pg.Client({ connectionString: target.href });
await bootstrap.connect();
await bootstrap.query("CREATE SCHEMA " + schema);
await bootstrap.end();
target.searchParams.set("options", "-c search_path=" + schema);
process.env.DATABASE_URL = target.href;
const server = await startMahjongServer({ host: "127.0.0.1", port: 2583 });
const sdk = new Client(server.url);
const report = (event, data) =>
  console.log(
    JSON.stringify({ event, time: new Date().toISOString(), schema, ...data }),
  );
let violations = 0,
  reconnects = 0,
  views = 0;
const timings = [];
const groups = [];
const confirmations = new Map();
const owners = new Map();
let privateViewErrors = 0,
  notices = 0;
function percentile(samples) {
  return samples.length
    ? [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
    : null;
}
async function join(cookie, id, seat) {
  const res = await fetch(
    server.url + "/api/rooms" + (id ? "/" + id + "/seat" : ""),
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(
    res.status,
    id ? 200 : 201,
    "seat reservation failed: " + res.status,
  );
  const room = await sdk.consumeSeatReservation(await res.json());
  room.reconnection.enabled = false;
  const client = { room, cookie, view: null };
  room.onMessage("notice", () => {
    violations++;
    notices++;
  });
  room.onMessage("view", (v) => {
    views++;
    if (
      v.rulesVersion !== "wj-2" ||
      v.id !== room.roomId ||
      v.seat !== seat ||
      v.players.some((p) => "hand" in p || "id" in p) ||
      (v.round &&
        ("wall" in v.round ||
          v.round.players.some((p) => "hand" in p) ||
          v.round.hand.length !== v.round.players[seat].handCount))
    ) {
      violations++;
      privateViewErrors++;
    }
    client.view = v;
  });
  room.send("sync");
  return client;
}
async function until(predicate) {
  const until = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > until) throw Error("authoritative view timeout");
    await sleep(8);
  }
}
async function create() {
  const g = [];
  for (let seat = 0; seat < 4; seat++) {
    const id = randomUUID(),
      key = randomBytes(32).toString("hex");
    await db().query("INSERT INTO players(id,name,avatar) VALUES($1,$2,$3)", [
      id,
      "测试" + seat,
      seat,
    ]);
    await db().query(
      "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '2 hours')",
      [createHash("sha256").update(key).digest("hex"), id],
    );
    if (seat === 0) {
      const account = await db().query(
        "INSERT INTO accounts(username,password_hash,primary_player) VALUES($1,$2,$3) RETURNING id",
        [randomUUID(), "synthetic-disabled", id],
      );
      await db().query("UPDATE players SET account_id=$1 WHERE id=$2", [
        account.rows[0].id,
        id,
      ]);
    }
    g.push(await join("wj_session=" + key, g[0]?.room.roomId, seat));
    if (seat === 0) {
      assert.ok(!owners.has(g[0].room.roomId));
      owners.set(g[0].room.roomId, []);
    }
    owners.get(g[0].room.roomId).push(id);
  }
  return g;
}
async function play(g, index, start, end) {
  g[0].room.send("start");
  await until(() => g.every((c) => c.view?.round));
  await sleep((index * pace) / tables);
  const confirmed = { initial: g[0].view.round.revision, count: 0 };
  confirmations.set(g[0].room.roomId, confirmed);
  let resumed = false;
  while (Date.now() < end) {
    const tick = performance.now();
    if (!resumed && Date.now() > start + (end - start) * 0.5) {
      const c = g[1],
        hand = c.view.round.hand;
      await c.room.leave(false);
      await until(() => !g[0].view.players[1].connected);
      g[1] = await join(c.cookie, g[0].room.roomId, 1);
      await until(() => g[1].view?.players[1].connected);
      assert.deepEqual(g[1].view.round.hand, hand);
      resumed = true;
      reconnects++;
    }
    const round = g[0].view.round,
      revision = round.revision;
    if (round.result) {
      for (const c of g) c.room.send("ready");
    } else {
      const choices = g.map(
        (c) =>
          c.view.round.actions.find((a) => a.type === "hu") ??
          c.view.round.actions.find(
            (a) => a.type === "discard" || a.type === "pass",
          ),
      );
      const seat = choices.findIndex(Boolean);
      assert.ok(seat >= 0, "missing legal action");
      g[seat].room.send("action", { revision, action: choices[seat] });
    }
    const sent = performance.now();
    await until(() => g.every((c) => c.view.round.revision > revision));
    timings.push(performance.now() - sent);
    confirmed.count++;
    assert.equal(g[0].view.round.revision, confirmed.initial + confirmed.count);
    await sleep(Math.max(0, pace - (performance.now() - tick)));
  }
}
try {
  for (let offset = 0; offset < tables; offset += 4)
    groups.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(4, tables - offset) }, () => create()),
      )),
    );
  const start = Date.now(),
    end = start + duration * 1000;
  report("started", { tables, players: 4 * tables, duration, pace });
  const timer = setInterval(
    () =>
      report("progress", {
        actions: timings.length,
        views,
        reconnects,
        violations,
        privateViewErrors,
        notices,
        p95: percentile(timings),
      }),
    60000,
  );
  try {
    await Promise.all(groups.map((g, i) => play(g, i, start, end)));
  } finally {
    clearInterval(timer);
  }
  const { rows } = await db().query(
    "SELECT g.id,g.state,coalesce(jsonb_agg(r.detail ORDER BY r.number) FILTER(WHERE r.number IS NOT NULL),'[]') rounds FROM game_rooms g LEFT JOIN game_rounds r ON g.id=r.room_id GROUP BY g.id",
  );
  assert.equal(rows.length, tables);
  let settlements = 0,
    settledTables = 0;
  let lostConfirmedRevisions = 0;
  for (const { id, state, rounds } of rows) {
    const confirmed = confirmations.get(id);
    assert.ok(confirmed);
    lostConfirmedRevisions += Math.abs(
      confirmed.initial + confirmed.count - state.revision,
    );
    assert.deepEqual(
      state.players.map((p) => p.id),
      owners.get(id),
    );
    assert.equal(state.rulesVersion, "wj-2");
    assert.equal(state.completed, rounds.length);
    assert.equal(state.closed, false);
    const totals = [0, 0, 0, 0];
    for (const [i, r] of rounds.entries()) {
      assert.equal(r.number, i + 1);
      assert.equal(
        r.result.deltas.reduce((a, b) => a + b, 0),
        0,
      );
      r.result.deltas.forEach((p, j) => (totals[j] += p));
    }
    assert.deepEqual(
      state.players.map((p) => p.points),
      totals,
    );
    if (duration >= 600) assert.ok(rounds.length > 0);
    if (rounds.length) settledTables++;
    settlements += rounds.length;
  }
  const membership = await db().query(
    "SELECT player_id,room_id FROM history_players",
  );
  assert.equal(membership.rowCount, settledTables * 4);
  for (const row of membership.rows)
    assert.ok(owners.get(row.room_id)?.includes(row.player_id));
  if ((duration * 1000) / pace >= 200) assert.equal(settledTables, tables);
  const overlap = await db().query(
    "SELECT coalesce(max(tables),0)::int busiest FROM (SELECT count(distinct room_id) tables FROM game_rounds GROUP BY date_trunc('second',settled_at)) counts",
  );
  const concurrentSettlements = overlap.rows[0].busiest;
  assert.equal(owners.size, tables);
  assert.equal(new Set([...owners.values()].flat()).size, tables * 4);
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  report("result", {
    tables,
    durationMs: Date.now() - start,
    players: 4 * tables,
    settlements,
    settledTables,
    historyPlayers: membership.rowCount,
    actions: timings.length,
    reconnects,
    violations,
    views,
    p95,
    notices,
    privateViewErrors,
    lostConfirmedRevisions,
    uniqueRoomOwners: owners.size,
    maxTablesSettledInOneSecond: concurrentSettlements,
  });
  assert.equal(violations, 0);
  assert.equal(reconnects, tables);
  assert.ok(p95 <= 300);
  assert.equal(lostConfirmedRevisions, 0);
  if (tables === 100 && duration >= 600) assert.ok(concurrentSettlements >= 2);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await server.close();
  await db().end();
}
