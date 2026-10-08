// Netlify Database (managed Postgres). getDatabase() needs no configuration on Netlify.
import { getDatabase } from '@netlify/database';

let db;
const get = () => db || (db = getDatabase());

export const pgAdapter = {
  async exec(text, params = []) {
    const r = await get().pool.query(text, params);
    return r.rows;
  },
  async tx(fn) {
    const client = await get().pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(async (text, params = []) => (await client.query(text, params)).rows);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }
};
