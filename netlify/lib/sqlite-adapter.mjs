// Local stand-in for Postgres, used by `npm run local` and the tests. Needs Node 22.13+.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users(lower(username));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_by TEXT, PRIMARY KEY(collection,id));
CREATE INDEX IF NOT EXISTS docs_month ON docs(collection, (data->>'month'));
CREATE TABLE IF NOT EXISTS meta(collection TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, user_id TEXT, action TEXT NOT NULL, collection TEXT, doc_id TEXT);
CREATE TABLE IF NOT EXISTS login_fails(fkey TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL);
`;

export function sqliteAdapter(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const tr = (sql) => sql.replace(/\$(\d+)/g, '?$1').replace(/::jsonb/g, '').replace(/now\(\)/g, 'CURRENT_TIMESTAMP');
  const bind = (p) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const run = (text, params = []) => {
    const s = db.prepare(tr(text));
    if (/^\s*(SELECT|WITH)/i.test(text)) return s.all(...bind(params));
    s.run(...bind(params));
    return [];
  };
  let chain = Promise.resolve();
  return {
    async exec(text, params) { return run(text, params); },
    tx(fn) {
      const p = chain.catch(() => {}).then(async () => {
        db.exec('BEGIN');
        try { const out = await fn(async (t, params) => run(t, params)); db.exec('COMMIT'); return out; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      chain = p;
      return p;
    }
  };
}
