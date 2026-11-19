import { startMahjongServer } from './app.ts';

const server = await startMahjongServer({
  port: Number(process.env.PORT ?? 2567),
  host: process.env.HOST ?? '0.0.0.0',
});
console.log(`吴江麻王运行于 ${server.url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close(); });
}
