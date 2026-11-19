import pg, { type PoolClient } from 'pg';

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString && !process.env.PGHOST) throw new Error('请配置 DATABASE_URL 或 PGHOST 连接 PostgreSQL。');
    pool = new pg.Pool({ connectionString, max: 32, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000, allowExitOnIdle: true, application_name: 'wujiang-mawang' });
    pool.on('error', (error) => console.error('PostgreSQL 连接中断', error.name));
  }
  return pool;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
