import { randomBytes } from 'node:crypto';
import { before, after } from 'node:test';
import pg from 'pg';

// Integration tests, including forked game servers, share one fresh schema per test file.
export function isolateDatabase() {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) return 'set TEST_DATABASE_URL to run PostgreSQL integration tests';
  const schema = 'mawang_test_' + randomBytes(12).toString('hex');
  const admin = new pg.Client({ connectionString: source });
  before(async () => {
    await admin.connect();
    await admin.query('CREATE SCHEMA ' + schema);
    const isolated = new URL(source);
    isolated.searchParams.set('options', '-c search_path=' + schema);
    process.env.DATABASE_URL = isolated.href;
  });
  after(async () => {
    try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });
  return false;
}
