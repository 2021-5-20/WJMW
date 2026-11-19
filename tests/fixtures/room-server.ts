import { startMahjongServer } from '../../src/server/app.ts';
const server = await startMahjongServer({ host: '127.0.0.1', port: 0 });
process.send!(server.url);
