import { resolve } from 'node:path';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { roomType } from '../shared/protocol.ts';
import { MahjongRoom } from './mahjong-room.ts';
import { db } from './db.ts';
import { initializeAuth, scheduleAuthCleanup } from './auth.ts';
import { initializeRooms } from './rooms.ts';
import { initializeOperations } from './operations.ts';
import { mountApi } from './http.ts';

interface ServerOptions {
  port?: number;
  host?: string;
  dist?: string;
}

export async function startMahjongServer(options: ServerOptions = {}) {
  const host = options.host ?? '0.0.0.0';
  const dist = resolve(options.dist ?? 'dist');
  const lease = await db().connect();
  if (!(await lease.query('SELECT pg_try_advisory_lock(730424, 1) AS owned')).rows[0].owned) {
    lease.release();
    throw new Error('此数据库已有运行中的游戏服务。');
  }
  let ready = false;
  let closing = false;
  lease.on('error', () => {
    ready = false;
    if (!closing) { console.error('数据库服务租约中断，进程将重启。'); process.exit(1); }
  });
  async function releaseLease() {
    try { await lease.query('SELECT pg_advisory_unlock(730424, 1)'); }
    finally { lease.release(true); }
  }
  try {
    await initializeAuth();
    await initializeOperations();
  } catch (error) { await releaseLease(); throw error; }
  matchMaker.controller.exposedMethods = [];
  const transport = new WebSocketTransport({ maxPayload: 4096 });
  const game = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
    express(app) {
      mountApi(app, () => ready);
      app.get('/', (_, response) => {
        response.sendFile('index.html', { root: dist }, (error) => {
          if (error && !response.headersSent) response.status(503).send('请先执行 npm run build，或打开 Vite 开发地址。');
        });
      });
      app.use(express.static(dist, { index: false, dotfiles: 'deny' }));
    },
  });
  game.define(roomType, MahjongRoom);
  try {
    await game.listen(options.port ?? 2567, host);
    await initializeRooms();
    ready = true;
  } catch (error) {
    await game.gracefullyShutdown(false).catch(() => {});
    await releaseLease();
    throw error;
  }
  const address = transport.server?.address();
  if (!address || typeof address === 'string') throw new Error('无法读取牌局服务端口。');
  const urlHost = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const cleanup = scheduleAuthCleanup();
  return {
    url: `http://${urlHost}:${address.port}`,
    async close() {
      if (closing) return;
      closing = true;
      ready = false;
      clearInterval(cleanup);
      try { await game.gracefullyShutdown(false); } finally { await releaseLease(); }
    },
  };
}
