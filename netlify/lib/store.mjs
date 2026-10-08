// Storage layer. One set of SQL (PostgreSQL dialect) used with two adapters:
//   - pg-adapter.mjs     : Netlify Database (production)
//   - sqlite-adapter.mjs : local testing and `npm run local` (translates the few dialect differences)
export const COLLECTION_LIST = ['sites', 'employees', 'attendance', 'runs', 'runlines', 'approvals', 'config'];

export function createStore({ exec, tx }) {
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const one = async (t, p = []) => (await exec(t, p))[0] || null;
  const user = (r) => (r ? { ...r, active: !!r.active } : null);
  const PUT = `INSERT INTO docs(collection,id,data,version,updated_by) VALUES($1,$2,$3::jsonb,1,$4)
    ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`;
  const BUMP = `INSERT INTO meta(collection,rev) VALUES($1,1) ON CONFLICT(collection) DO UPDATE SET rev=meta.rev+1`;
  const bumpAll = async (q) => { for (const c of COLLECTION_LIST) await q(BUMP, [c]); };

  return {
    /* users */
    async userCount() { return Number((await one('SELECT COUNT(*) AS n FROM users')).n); },
    async userById(id) { return user(await one('SELECT * FROM users WHERE id=$1', [id])); },
    async userByName(n) { return user(await one('SELECT * FROM users WHERE lower(username)=lower($1)', [n])); },
    async listUsers() { return (await exec('SELECT id,username,name,role,active FROM users ORDER BY name')).map(user); },
    async insertUser(u) { await exec('INSERT INTO users(id,username,name,role,pass,active) VALUES($1,$2,$3,$4,$5,TRUE)', [u.id, u.username, u.name, u.role, u.pass]); },
    async activeManagers() { return Number((await one("SELECT COUNT(*) AS n FROM users WHERE role='manager' AND active=TRUE")).n); },
    async updateUser(id, u) { await exec('UPDATE users SET name=$1, role=$2, active=$3, pass=$4 WHERE id=$5', [u.name, u.role, !!u.active, u.pass, id]); },
    /* sessions */
    async insertSession(token, userId, expires) { await exec('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [token, userId, expires]); },
    async getSession(token) { const r = await one('SELECT user_id, expires FROM sessions WHERE token=$1', [token]); return r ? { userId: r.user_id, expires: Number(r.expires) } : null; },
    async touchSession(token, expires) { await exec('UPDATE sessions SET expires=$1 WHERE token=$2', [expires, token]); },
    async deleteSession(token) { await exec('DELETE FROM sessions WHERE token=$1', [token]); },
    async deleteUserSessions(userId) { await exec('DELETE FROM sessions WHERE user_id=$1', [userId]); },
    async purgeSessions(now) { await exec('DELETE FROM sessions WHERE expires<$1', [now]); },
    /* sign-in throttling */
    async getFail(k) { const r = await one('SELECT n,t FROM login_fails WHERE fkey=$1', [k]); return r ? { n: Number(r.n), t: Number(r.t) } : null; },
    async setFail(k, n, t) { await exec('INSERT INTO login_fails(fkey,n,t) VALUES($1,$2,$3) ON CONFLICT(fkey) DO UPDATE SET n=EXCLUDED.n, t=EXCLUDED.t', [k, n, t]); },
    async clearFail(k) { await exec('DELETE FROM login_fails WHERE fkey=$1', [k]); },
    /* documents */
    async getDoc(c, id) { const r = await one('SELECT data FROM docs WHERE collection=$1 AND id=$2', [c, id]); return r ? parse(r.data) : null; },
    async listDocs(c, month) {
      const rows = month == null
        ? await exec('SELECT id,data FROM docs WHERE collection=$1', [c])
        : await exec("SELECT id,data FROM docs WHERE collection=$1 AND data->>'month'=$2", [c, month]);
      return rows.map((r) => ({ id: r.id, data: parse(r.data) }));
    },
    async putDoc(c, id, data, by) { await tx(async (q) => { await q(PUT, [c, id, JSON.stringify(data), by || null]); await q(BUMP, [c]); }); },
    async deleteDoc(c, id) { await tx(async (q) => { await q('DELETE FROM docs WHERE collection=$1 AND id=$2', [c, id]); await q(BUMP, [c]); }); },
    async batch(ops, by) {
      await tx(async (q) => {
        const touched = new Set();
        for (const o of ops) {
          if (o.op === 'delete') await q('DELETE FROM docs WHERE collection=$1 AND id=$2', [o.c, o.id]);
          else await q(PUT, [o.c, o.id, JSON.stringify(o.data), by || null]);
          touched.add(o.c);
        }
        for (const c of touched) await q(BUMP, [c]);
      });
    },
    async allDocs() { return (await exec('SELECT collection,id,data FROM docs ORDER BY collection,id')).map((r) => ({ collection: r.collection, id: r.id, data: parse(r.data) })); },
    async docCount() { return Number((await one('SELECT COUNT(*) AS n FROM docs')).n); },
    async wipe() { await tx(async (q) => { await q('DELETE FROM docs'); await bumpAll(q); }); },
    async restore(docs, by) {
      await tx(async (q) => {
        await q('DELETE FROM docs');
        for (const d of docs) await q(PUT, [d.collection, d.id, JSON.stringify(d.data), by || null]);
        await bumpAll(q);
      });
    },
    async pulse() { const o = {}; (await exec('SELECT collection,rev FROM meta')).forEach((r) => { o[r.collection] = Number(r.rev); }); return o; },
    async audit(by, action, c, id) { await exec('INSERT INTO audit(user_id,action,collection,doc_id) VALUES($1,$2,$3,$4)', [by || null, action, c || null, id || null]); }
  };
}
