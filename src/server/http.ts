import { randomUUID } from 'node:crypto';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { currentPlayer, mountAuth } from './auth.ts';
import { activeRoom, reserveRoom, roomPreview } from './rooms.ts';
import { historyPage, readHistoryCursor } from './history.ts';
import { db } from './db.ts';
import { mountOperations } from './operations.ts';
import { sessionHash } from './session-control.ts';

export function mountApi(app: Application, ready: () => boolean) {
  app.disable('x-powered-by');
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      if (!ready()) throw new Error('starting');
      await db().query('SELECT 1');
      res.json({ ready: true });
    } catch { res.status(503).json({ ready: false }); }
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!ready()) { res.status(503).json({ error: '服务正在恢复，请稍后再试。' }); return; }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      const expected = process.env.APP_ORIGIN || req.protocol + '://' + req.get('host');
      if ((origin && origin !== new URL(expected).origin) || req.get('sec-fetch-site') === 'cross-site') {
        res.status(403).json({ error: '请从游戏页面提交请求。' }); return;
      }
      if (!req.is('application/json')) { res.status(415).json({ error: '需要 JSON 请求。' }); return; }
    }
    next();
  }, express.json({ limit: '8kb' }));
  mountAuth(app);
  app.get('/api/me', async (req, res) => {
    const player = await currentPlayer(req);
    if (!player) { res.json({ player: null, activeRoom: null }); return; }
    const { playerIds, ...profile } = player;
    res.json({ player: profile, activeRoom: await activeRoom(playerIds) });
  });
  app.get('/api/rooms/:id', async (req, res) => {
    const room = await roomPreview(req.params.id);
    if (!room) { res.status(404).json({ error: '找不到这间好友房。' }); return; }
    res.json(room);
  });
  async function seat(req: Request, res: Response) {
    const player = await currentPlayer(req);
    if (!player) { res.status(401).json({ error: '请先登录或以游客身份入座。' }); return; }
    const roomId = typeof req.params.id === 'string' ? req.params.id : undefined;
    if (!roomId && !player.registered) { res.status(403).json({ error: '请先登录正式账号再创建房间。' }); return; }
    try { res.status(roomId ? 200 : 201).json(await reserveRoom(player, roomId, sessionHash(req))); }
    catch (error) {
      // Only relay room-domain messages; database and network errors go to diagnostics.
      if (error instanceof Error && /^(请|玩家|房间|座位|牌桌|账号)/u.test(error.message)) {
        res.status(409).json({ error: error.message }); return;
      }
      throw error;
    }
  }
  app.post('/api/rooms', seat);
  app.post('/api/rooms/:id/seat', seat);
  app.get('/api/history', async (req, res) => {
    const player = await currentPlayer(req);
    if (!player) { res.status(401).json({ error: '请先入座或登录查看战绩。' }); return; }
    let before: [string,string] | null;
    try { before = readHistoryCursor(req.query.cursor); }
    catch { res.status(400).json({ error: '战绩分页参数无效。' }); return; }
    res.json(await historyPage(player.playerIds, before));
  });
  mountOperations(app);
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (error.status === 400 || error.status === 413) {
      res.status(error.status).json({ error: '请求内容格式或大小有误。' }); return;
    }
    const reference = randomUUID();
    console.error('服务异常', reference, error.name);
    void db().query('INSERT INTO service_incidents(reference,category) VALUES($1,$2)', [reference, error.name])
      .catch(() => { /* The server log retains the reference during database outages. */ });
    res.status(503).json({ error: '服务暂不可用，异常编号 ' + reference });
  });
}
