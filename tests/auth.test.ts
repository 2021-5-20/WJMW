import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  currentPlayer,
  initializeAuth,
  mountAuth,
} from "../src/server/auth.ts";
import { initializeRooms } from "../src/server/rooms.ts";
import { db } from "../src/server/db.ts";
import { isolateDatabase } from "./fixtures/isolated-db.ts";

test(
  "guest registration, session rotation and verified recovery",
  { skip: isolateDatabase() },
  async (t) => {
    const preview = await mkdtemp(join(tmpdir(), "mawang-mail-"));
    process.env.MAIL_PREVIEW_DIR = preview;
    process.env.APP_ORIGIN = "http://localhost";
    t.after(() => rm(preview, { recursive: true, force: true }));
    await initializeAuth();
    const app = express();
    app.use(express.json());
    mountAuth(app);
    app.get("/me", async (req, res) => {
      res.json(await currentPlayer(req));
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    let cookie = "";
    const post = async (action: string, body: unknown) => {
      const response = await fetch(url + "/api/auth/" + action, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      return response.status;
    };
    const me = async (value = cookie) =>
      (await fetch(url + "/me", { headers: { cookie: value } })).json();
    assert.equal(await post("guest", { name: "阿吴", avatar: 2 }), 200);
    const guest = await me();
    const old = cookie;
    const credentials = {
      username: "u" + randomBytes(8).toString("hex"),
      password: "a-sample-password",
      email: randomBytes(8).toString("hex") + "@example.test",
    };
    assert.equal(await post("register", credentials), 200);
    assert.equal(await me(old), null);
    assert.equal((await me()).id, guest.id);
    assert.equal((await me()).registered, true);
    assert.equal(await post("logout", {}), 200);
    assert.equal(await me(), null);
    assert.equal(
      await post("login", { ...credentials, password: "wrong" }),
      400,
    );
    assert.equal(await post("login", credentials), 200);
    assert.equal((await me()).name, "阿吴");
    assert.equal(await post("verify", { token: "invalid" }), 400);
    assert.equal(
      await post("reset", { token: "invalid", password: "new-password" }),
      400,
    );
    async function token(purpose: string) {
      for (const file of await readdir(preview)) {
        const mail = JSON.parse(await readFile(join(preview, file), "utf8"));
        if (mail.purpose === purpose)
          return new URL(mail.url).searchParams.get(purpose);
      }
      return null;
    }
    assert.equal(await post("forgot", { email: credentials.email }), 200);
    assert.equal(await token("reset"), null);
    const verification = await token("verify");
    assert.ok(verification);
    assert.equal(await post("verify", { token: verification }), 200);
    assert.equal((await me()).verified, true);
    assert.equal(await post("verify", { token: verification }), 400);
    assert.equal(await post("forgot", { email: credentials.email }), 200);
    const reset = await token("reset");
    assert.ok(reset);
    const password = "another-password";
    assert.equal(await post("reset", { token: reset, password }), 200);
    assert.equal(await me(), null);
    assert.equal(await post("reset", { token: reset, password }), 400);
    assert.equal(await post("login", credentials), 400);
    assert.equal(await post("login", { ...credentials, password }), 200);
    await initializeRooms();
    assert.equal(await post("logout", {}), 200);
    assert.equal(await post("guest", { name: "游客二号", avatar: 0 }), 200);
    const tourist = await me();
    const guestCookie = cookie;
    const table = randomBytes(8).toString("hex");
    const insertRoom = async (key: string, id: string) =>
      db().query("INSERT INTO game_rooms(id,version,state) VALUES($1,1,$2)", [
        key,
        { closed: false, players: [{ id }] },
      ]);
    await insertRoom(table, guest.id);
    await insertRoom(table + "b", tourist.id);
    try {
      assert.equal(await post("login", { ...credentials, password }), 400);
      assert.equal((await me()).registered, false);
      await db().query("DELETE FROM game_rooms WHERE id=$1", [table]);
      assert.equal(await post("login", { ...credentials, password }), 200);
      assert.equal(await me(guestCookie), null);
      assert.deepEqual(
        new Set((await me()).playerIds),
        new Set([guest.id, tourist.id]),
      );
      assert.equal((await me()).name, guest.name);
      assert.equal((await me()).id, tourist.id);
      await db().query("DELETE FROM game_rooms WHERE id=$1", [table + "b"]);
      assert.equal((await me()).id, guest.id);
    } finally {
      await db().query("DELETE FROM game_rooms WHERE id=ANY($1::text[])", [
        [table, table + "b"],
      ]);
      await db().end();
    }
  },
);
