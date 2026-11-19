import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Application, Request, Response } from "express";
import type { PoolClient } from "pg";
import nodemailer from "nodemailer";
import { db, transaction } from "./db.ts";
import { sessionHash as sessionKey, sessionEvents } from "./session-control.ts";
async function seated(ids: string[], c: PoolClient | ReturnType<typeof db>) {
  const result = await c.query(
    "SELECT member->>'id' id FROM game_rooms CROSS JOIN LATERAL jsonb_array_elements(state->'players') member WHERE (state->>'closed')::boolean=false AND member->>'id'=ANY($1::text[]) LIMIT 1",
    [ids],
  );
  return result.rows[0]?.id as string | undefined;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const cookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
class InputError extends Error {}
function fail(message: string): never {
  throw new InputError(message);
}

export async function initializeAuth() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE NOT NULL, email text UNIQUE, password_hash text NOT NULL, verified boolean NOT NULL DEFAULT false, primary_player uuid, is_admin boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts, name text NOT NULL, avatar integer NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS players_account ON players(account_id);
    CREATE TABLE IF NOT EXISTS auth_sessions(key text PRIMARY KEY, player_id uuid NOT NULL REFERENCES players, expires timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_tokens(key text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts, purpose text NOT NULL, expires timestamptz NOT NULL, UNIQUE(account_id,purpose));
    CREATE TABLE IF NOT EXISTS auth_limits(key text PRIMARY KEY, count int NOT NULL, expires timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_sessions_by_player ON auth_sessions(player_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_by_expiry ON auth_sessions(expires);
    CREATE INDEX IF NOT EXISTS auth_limits_by_expiry ON auth_limits(expires);
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS primary_player uuid;
    UPDATE accounts a SET primary_player=(SELECT p.id FROM players p WHERE p.account_id=a.id ORDER BY p.id LIMIT 1)
      WHERE primary_player IS NULL AND EXISTS (SELECT 1 FROM players p WHERE p.account_id=a.id);
  `);
}

export function scheduleAuthCleanup() {
  const timer = setInterval(() => {
    void db().query(`DELETE FROM auth_sessions WHERE expires<now();
      DELETE FROM auth_tokens WHERE expires<now(); DELETE FROM auth_limits WHERE expires<now();`)
      .catch(() => console.error("过期会话清理将在下个周期重试"));
  }, 3600000);
  return timer.unref();
}
async function identity(req: Request, c: PoolClient | ReturnType<typeof db>) {
  return (
    await c.query(
      "SELECT p.*,a.primary_player,coalesce(a.verified,false) verified FROM auth_sessions s JOIN players p ON p.id=s.player_id LEFT JOIN accounts a ON a.id=p.account_id WHERE s.key=$1 AND s.expires>now()",
      [sessionKey(req)],
    )
  ).rows[0];
}
async function aliases(
  account: string,
  c: PoolClient | ReturnType<typeof db>,
): Promise<string[]> {
  return (
    await c.query("SELECT id FROM players WHERE account_id=$1 ORDER BY id", [
      account,
    ])
  ).rows.map((r) => r.id);
}
export async function currentPlayer(req: Request) {
  const p = await identity(req, db());
  if (!p) return null;
  const ids = p.account_id ? await aliases(p.account_id, db()) : [p.id];
  if (ids.length > 1) p.id = (await seated(ids, db())) ?? p.primary_player;
  return {
    id: p.id as string,
    name: p.name as string,
    avatar: p.avatar as number,
    registered: Boolean(p.account_id),
    playerIds: ids as string[],
    verified: Boolean(p.verified),
  };
}
async function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    argon2(
      "argon2id",
      {
        message: password,
        nonce: Buffer.from(salt, "hex"),
        parallelism: 1,
        memory: 19456,
        passes: 2,
        tagLength: 32,
      },
      (e, b) => (e ? reject(e) : resolve(b)),
    ),
  );
}
function profile(
  b: Record<string, unknown>,
  prior?: { name: string; avatar: number },
) {
  const name = b.name ?? prior?.name ?? "游客",
    avatar = b.avatar ?? prior?.avatar ?? 0;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 24 ||
    !Number.isInteger(avatar) ||
    Number(avatar) < 0 ||
    Number(avatar) > 3
  )
    fail("请填写有效昵称并选择头像");
  return { name: name.trim(), avatar: Number(avatar) };
}
async function sendToken(
  c: PoolClient,
  id: string,
  email: string,
  purpose: "verify" | "reset",
) {
  const preview =
    process.env.NODE_ENV !== "production" && process.env.MAIL_PREVIEW_DIR;
  if (
    !process.env.APP_ORIGIN ||
    (!preview && (!process.env.SMTP_URL || !process.env.MAIL_FROM))
  )
    fail("邮件服务尚未配置");
  const allowed = await c.query(
    "INSERT INTO auth_limits VALUES($1,1,now()+interval '10 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_limits.expires<=now() THEN 1 ELSE auth_limits.count+1 END,expires=CASE WHEN auth_limits.expires<=now() THEN excluded.expires ELSE auth_limits.expires END RETURNING count",
    [hash("mail|" + email)],
  );
  if (allowed.rows[0].count > 3) return;
  const token = secret();
  await c.query(
    "INSERT INTO auth_tokens VALUES($1,$2,$3,now()+interval '30 minutes') ON CONFLICT(account_id,purpose) DO UPDATE SET key=excluded.key,expires=excluded.expires",
    [hash(token), id, purpose],
  );
  const url = new URL("/", process.env.APP_ORIGIN);
  url.searchParams.set(purpose, token);
  return async () => {
    if (preview) {
      await mkdir(preview, { recursive: true, mode: 0o700 });
      await writeFile(
        join(preview, secret() + ".json"),
        JSON.stringify({ email, purpose, url: url.href }),
        { mode: 0o600 },
      );
      return;
    }
    await nodemailer.createTransport(process.env.SMTP_URL!).sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: purpose === "verify" ? "吴江麻王邮箱验证" : "吴江麻王重设密码",
      text: "请在30分钟内打开链接：" + url.href,
    });
  };
}
async function consumeToken(
  c: PoolClient,
  action: "reset" | "verify",
  token: unknown,
  credential?: string,
  revoke: string[] = [],
) {
  const t = (
    await c.query(
      "DELETE FROM auth_tokens WHERE key=$1 AND purpose=$2 AND expires>now() RETURNING account_id",
      [hash(String(token)), action],
    )
  ).rows[0];
  if (!t) fail("链接已失效");
  if (action === "verify")
    await c.query("UPDATE accounts SET verified=true WHERE id=$1", [
      t.account_id,
    ]);
  else {
    await c.query("UPDATE accounts SET password_hash=$1 WHERE id=$2", [
      credential,
      t.account_id,
    ]);
    const removed = await c.query(
      "DELETE FROM auth_sessions WHERE player_id IN (SELECT id FROM players WHERE account_id=$1) RETURNING key",
      [t.account_id],
    );
    revoke.push(...removed.rows.map(row => row.key as string));
  }
}
async function authenticate(
  username: string,
  password: string,
): Promise<{ id: string; password_hash: string }> {
  const candidate = (
    await db().query("SELECT * FROM accounts WHERE username=$1", [username])
  ).rows[0];
  const [salt, expected] = (
    candidate?.password_hash ?? "0".repeat(32) + ":" + "0".repeat(64)
  ).split(":");
  if (
    !timingSafeEqual(
      await derive(password.slice(0, 128), salt),
      Buffer.from(expected, "hex"),
    ) ||
    !candidate ||
    password.length > 128
  )
    fail("用户名或密码有误");
  return candidate;
}
export function mountAuth(app: Application) {
  const route = (action: string) => async (req: Request, res: Response) => {
    const b = req.body ?? {};
    try {
      const bucket = hash(action + "|" + (req.ip ?? ""));
      const limit = await db().query(
        "INSERT INTO auth_limits VALUES($1,1,now()+interval '10 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_limits.expires<=now() THEN 1 ELSE auth_limits.count+1 END, expires=CASE WHEN auth_limits.expires<=now() THEN excluded.expires ELSE auth_limits.expires END RETURNING count",
        [bucket],
      );
      if (limit.rows[0].count > 60) {
        res.status(429).json({ error: "请求过于频繁，请稍后再试" });
        return;
      }
      const username =
        typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
      const email =
        typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const password = typeof b.password === "string" ? b.password : "";
      let credential: string | undefined;
      let candidate: { id: string; password_hash: string } | undefined;
      let deliver: (() => Promise<void>) | undefined;
      const revoked: string[] = [];
      if (action === "register" || action === "reset") {
        if (password.length < 8 || password.length > 128)
          fail("密码长度应为8至128位");
        const salt = randomBytes(16).toString("hex");
        credential =
          salt + ":" + (await derive(password, salt)).toString("hex");
      }
      if (action === "login") {
        candidate = await authenticate(username, password);
      }
      const fresh = await transaction(async (c) => {
        if (req.headers.cookie)
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,1))",
            [sessionKey(req)],
          );
        if (action === "login" || action === "register")
          await c.query("SELECT pg_advisory_xact_lock(716424)");
        const p = await identity(req, c);
        let id = p?.id;
        if (action === "logout") {
          await c.query("DELETE FROM auth_sessions WHERE key=$1", [
            sessionKey(req),
          ]);
          revoked.push(sessionKey(req));
          return "";
        }
        if (action === "profile") {
          if (!p) fail("请先登录");
          const v = profile(b, p);
          await c.query(
            "UPDATE players SET name=$1,avatar=$2 WHERE id=$3 OR account_id=$4",
            [v.name, v.avatar, id, p.account_id],
          );
          return;
        }
        if (action === "forgot" || action === "resend") {
          if (action === "resend" && !p?.account_id) fail("请先登录");
          const a = (
            await c.query(
              action === "forgot"
                ? "SELECT * FROM accounts WHERE email=$1 AND verified"
                : "SELECT * FROM accounts WHERE id=$1 AND NOT verified",
              [action === "forgot" ? email : p.account_id],
            )
          ).rows[0];
          if (a?.email)
            deliver = await sendToken(
              c,
              a.id,
              a.email,
              action === "forgot" ? "reset" : "verify",
            );
          return;
        }
        if (action === "reset" || action === "verify") {
          await consumeToken(c, action, b.token, credential, revoked);
          return;
        }
        if (action === "guest" && p) return;
        if (action === "register" || action === "guest") {
          if (p?.account_id) fail("当前账号已登录");
          const v = profile(b, p);
          if (!id)
            id = (
              await c.query(
                "INSERT INTO players(name,avatar) VALUES($1,$2) RETURNING id",
                [v.name, v.avatar],
              )
            ).rows[0].id;
          if (action === "register") {
            if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username))
              fail("用户名须为3至32位字母、数字、下划线或短横线");
            if (
              !email ||
              !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) ||
              email.length > 254
            )
              fail("邮箱格式无效");
            const a = (
              await c.query(
                "INSERT INTO accounts(username,email,password_hash,primary_player) VALUES($1,$2,$3,$4) RETURNING id",
                [username, email, credential, id],
              )
            ).rows[0];
            await c.query(
              "UPDATE players SET account_id=$1,name=$2,avatar=$3 WHERE id=$4",
              [a.id, v.name, v.avatar, id],
            );
            const removed = await c.query("DELETE FROM auth_sessions WHERE player_id=$1 RETURNING key", [id]);
            revoked.push(...removed.rows.map(row => row.key as string));
            deliver = await sendToken(c, a.id, email, "verify");
          }
        } else if (action === "login") {
          const a = (
            await c.query(
              "SELECT * FROM accounts WHERE id=$1 AND password_hash=$2 FOR UPDATE",
              [candidate!.id, candidate!.password_hash],
            )
          ).rows[0];
          if (!a) fail("请重新登录");
          const ids = await aliases(a.id, c);
          if (id && !p.account_id) {
            if ((await seated([id], c)) && (await seated(ids, c)))
              fail("两个身份都在牌桌中，请先结束其中一局");
            const removed = await c.query("DELETE FROM auth_sessions WHERE player_id=$1 RETURNING key", [id]);
            revoked.push(...removed.rows.map(row => row.key as string));
            await c.query(
              "UPDATE players g SET account_id=$1,name=p.name,avatar=p.avatar FROM players p WHERE g.id=$2 AND p.id=$3",
              [a.id, id, a.primary_player],
            );
          } else id = a.primary_player;
        }
        const key = secret();
        await c.query("DELETE FROM auth_sessions WHERE key=$1", [
          sessionKey(req),
        ]);
        if (p) revoked.push(sessionKey(req));
        await c.query(
          "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '30 days')",
          [hash(key), id],
        );
        return key;
      });
      if (revoked.length) sessionEvents.emit('revoke', revoked);
      if (fresh === "") res.clearCookie("wj_session", cookie);
      else if (fresh)
        res.cookie("wj_session", fresh, { ...cookie, maxAge: 30 * 86400000 });
      if (deliver) {
        try { await deliver(); }
        catch (error) {
          // Registration is already committed. Keep the user's new session usable for resending.
          if (action !== "register") throw error;
          console.error("注册验证邮件投递失败，可在个人资料中重发");
          res.json({ ok: true, mailDelayed: true });
          return;
        }
      }
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof InputError) res.status(400).json({ error: e.message });
      else if ((e as { code?: string }).code === "23505")
        res.status(409).json({ error: "用户名或邮箱已被使用" });
      else {
        console.error("认证请求失败", (e as Error).name);
        res.status(503).json({ error: "服务暂时不可用" });
      }
    }
  };
  for (const a of [
    "guest",
    "register",
    "login",
    "logout",
    "forgot",
    "reset",
    "verify",
    "resend",
  ])
    app.post("/api/auth/" + a, route(a));
  app.patch("/api/profile", route("profile"));
}
