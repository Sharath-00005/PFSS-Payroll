// PFSS Payroll API. Pure Request -> Response, so it runs inside a Netlify Function
// and inside the local test server with the same behaviour.
import crypto from 'node:crypto';

const COLLECTIONS = new Set(['sites', 'employees', 'attendance', 'runs', 'runlines', 'approvals', 'config']);
const ADMIN_ONLY = new Set(['approvals', 'config']);
const BATCH_OK = new Set(['attendance', 'runlines']);
const ROLES = new Set(['manager', 'payroll', 'viewer']);
const ID_RE = /^[A-Za-z0-9_.:@+-]{1,200}$/;
const USER_RE = /^[A-Za-z0-9_.@-]{3,40}$/;
const MAX_DOC = 256 * 1024;
const MAX_BODY = 5 * 1024 * 1024; // serverless request limit is about 6 MB
const WINDOW = 5 * 60e3;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const rid = (p) => p + crypto.randomBytes(5).toString('hex');
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sameSecret(a, b) {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });

export function createApi({ store }) {
  const SESSION_MS = (Number(process.env.SESSION_HOURS) || 12) * 3600e3;

  return async function handle(req, { ip = '?' } = {}) {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;
    const cookies = [];
    const send = (code, obj) => {
      const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      cookies.forEach((c) => h.append('Set-Cookie', c));
      return new Response(JSON.stringify(obj), { status: code, headers: h });
    };
    const fail = (code, msg) => send(code, { error: msg });
    const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    const cookie = (v, age) => `sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
    const readJson = async (limit = MAX_BODY) => {
      const t = await req.text();
      if (t.length > limit) throw { code: 413, msg: 'Request is too large.' };
      if (!t) return {};
      try { return JSON.parse(t); } catch { throw { code: 400, msg: 'Invalid JSON.' }; }
    };
    const startSession = async (userId) => {
      const token = crypto.randomBytes(32).toString('hex');
      await store.insertSession(sha(token), userId, Date.now() + SESSION_MS);
      cookies.push(cookie(token, Math.floor(SESSION_MS / 1000)));
    };
    const currentUser = async () => {
      const raw = (req.headers.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
      if (!raw) return null;
      const h = sha(raw.slice(4));
      const s = await store.getSession(h);
      if (!s || s.expires < Date.now()) return null;
      const u = await store.userById(s.userId);
      if (!u || !u.active) return null;
      if (s.expires - Date.now() < SESSION_MS / 2) await store.touchSession(h, Date.now() + SESSION_MS);
      return { ...publicUser(u), token: h };
    };

    /* business rules enforced here, not just on screen */
    const monthState = async (month, memo) => {
      if (memo.has(month)) return memo.get(month);
      const run = await store.getDoc('runs', month), ap = await store.getDoc('approvals', month);
      const st = {
        finalized: !!(run && run.finalized),
        approved: !!(run && run.hasCalc && ap && ap.decision === 'approved' && ap.stamp === run.stamp)
      };
      memo.set(month, st);
      return st;
    };
    const monthOfId = (id) => String(id).split('_')[0];
    const checkWrite = async (user, c, id, data, isDelete, memo = new Map()) => {
      if (user.role === 'viewer') return [403, 'Your account has view-only access.'];
      if (ADMIN_ONLY.has(c) && user.role !== 'manager') return [403, 'Only a manager can do this.'];
      if (c === 'attendance') {
        const st = await monthState(isDelete ? monthOfId(id) : String(data.month), memo);
        if (st.finalized || st.approved) return [409, 'This month is approved and locked.'];
      }
      if (c === 'runlines') {
        const st = await monthState(isDelete ? monthOfId(id) : String(data.month), memo);
        if (st.finalized) return [409, 'This month is closed and cannot be changed.'];
      }
      if (c === 'runs') {
        const cur = await store.getDoc('runs', id);
        if (cur && cur.finalized && (isDelete || !data.finalized)) return [409, 'This month is closed and cannot be changed.'];
      }
      if (c === 'approvals' && !isDelete) {
        const run = await store.getDoc('runs', id);
        if (data.decision === 'approved' && !(run && run.hasCalc && run.validated && run.submitted && run.stamp === data.stamp))
          return [409, 'This payroll is not ready for approval. It must be calculated, validated and submitted.'];
        if (data.decision !== 'approved' && data.decision !== 'rejected') return [400, 'Unknown decision.'];
      }
      return null;
    };

    try {
      if (!p.startsWith('/api/')) return fail(404, 'Not found.');
      if (m !== 'GET' && m !== 'HEAD' && req.headers.get('x-pfss') !== '1') return fail(403, 'Missing request header.');

      /* ----- no sign-in needed ----- */
      if (p === '/api/status' && m === 'GET') {
        return send(200, { setup: (await store.userCount()) === 0, keyRequired: !!process.env.SETUP_KEY });
      }
      if (p === '/api/setup' && m === 'POST') {
        if ((await store.userCount()) > 0) return fail(409, 'Setup is already complete.');
        const key = process.env.SETUP_KEY;
        if (!key) return fail(503, 'SETUP_KEY is not set. Add it under Site configuration > Environment variables in Netlify, redeploy, then try again.');
        const b = await readJson();
        if (!sameSecret(b.setupKey || '', key)) return fail(403, 'The setup key is not correct.');
        const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!name || !USER_RE.test(username)) return fail(400, 'Enter your name and a username of 3 to 40 letters, numbers or . _ - @');
        if (pw.length < 8) return fail(400, 'Password must be at least 8 characters.');
        const id = rid('u');
        await store.insertUser({ id, username, name, role: 'manager', pass: hashPw(pw) });
        await startSession(id);
        await store.audit(id, 'setup');
        return send(200, { ok: true });
      }
      if (p === '/api/login' && m === 'POST') {
        const b = await readJson();
        const username = String(b.username || '').trim();
        const fk = ip + '|' + username.toLowerCase();
        const f = await store.getFail(fk);
        if (f && f.n >= 5 && Date.now() - f.t < WINDOW) return fail(429, 'Too many failed attempts. Wait 5 minutes and try again.');
        const u = await store.userByName(username);
        if (!u || !u.active || !checkPw(String(b.password || ''), u.pass)) {
          await store.setFail(fk, f && Date.now() - f.t < WINDOW ? f.n + 1 : 1, Date.now());
          return fail(401, 'Username or password is incorrect.');
        }
        if (f) await store.clearFail(fk);
        await startSession(u.id);
        await store.audit(u.id, 'login');
        return send(200, { ok: true });
      }

      /* ----- everything below needs a signed-in user ----- */
      const user = await currentUser();
      if (!user) return fail(401, 'Please sign in.');

      if (p === '/api/logout' && m === 'POST') {
        await store.deleteSession(user.token);
        cookies.push(cookie('', 0));
        return send(200, { ok: true });
      }
      if (p === '/api/me' && m === 'GET') return send(200, publicUser(user));
      if (p === '/api/pulse' && m === 'GET') return send(200, await store.pulse());

      if (p === '/api/password' && m === 'POST') {
        const b = await readJson();
        const u = await store.userById(user.id);
        if (!checkPw(String(b.current || ''), u.pass)) return fail(400, 'Current password is incorrect.');
        if (String(b.next || '').length < 8) return fail(400, 'New password must be at least 8 characters.');
        await store.updateUser(u.id, { name: u.name, role: u.role, active: u.active, pass: hashPw(String(b.next)) });
        await store.audit(user.id, 'password-change');
        return send(200, { ok: true });
      }

      if (p === '/api/users' && m === 'GET') return send(200, await store.listUsers());
      if (p === '/api/users' && m === 'POST') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can add users.');
        const b = await readJson();
        const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!name || !USER_RE.test(username)) return fail(400, 'Enter a name and a username of 3 to 40 letters, numbers or . _ - @');
        if (!ROLES.has(b.role)) return fail(400, 'Choose a role.');
        if (pw.length < 8) return fail(400, 'Password must be at least 8 characters.');
        if (await store.userByName(username)) return fail(409, 'That username is already taken.');
        const id = rid('u');
        await store.insertUser({ id, username, name, role: b.role, pass: hashPw(pw) });
        await store.audit(user.id, 'user-add', 'users', id);
        return send(200, { id });
      }
      let mm = p.match(/^\/api\/users\/([A-Za-z0-9]+)$/);
      if (mm && m === 'PATCH') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can change users.');
        const t = await store.userById(mm[1]);
        if (!t) return fail(404, 'User not found.');
        const b = await readJson();
        const role = b.role !== undefined ? b.role : t.role;
        const active = b.active !== undefined ? !!b.active : t.active;
        if (!ROLES.has(role)) return fail(400, 'Unknown role.');
        const losesManager = t.role === 'manager' && t.active && (role !== 'manager' || !active);
        if (losesManager && (await store.activeManagers()) <= 1) return fail(409, 'There must always be at least one active manager.');
        const name = b.name !== undefined ? String(b.name).trim() || t.name : t.name;
        let pass = t.pass;
        if (b.password !== undefined) {
          if (String(b.password).length < 8) return fail(400, 'Password must be at least 8 characters.');
          pass = hashPw(String(b.password));
        }
        await store.updateUser(t.id, { name, role, active, pass });
        if (!active || b.password !== undefined) await store.deleteUserSessions(t.id);
        await store.audit(user.id, 'user-update', 'users', t.id);
        return send(200, { ok: true });
      }

      /* ----- documents ----- */
      mm = p.match(/^\/api\/c\/([a-z]+)$/);
      if (mm && m === 'GET') {
        const c = mm[1];
        if (!COLLECTIONS.has(c)) return fail(404, 'Unknown collection.');
        return send(200, await store.listDocs(c, url.searchParams.get('month')));
      }
      mm = p.match(/^\/api\/d\/([a-z]+)\/([^/]+)$/);
      if (mm) {
        const c = mm[1], id = decodeURIComponent(mm[2]);
        if (!COLLECTIONS.has(c) || !ID_RE.test(id)) return fail(404, 'Not found.');
        if (m === 'GET') { const d = await store.getDoc(c, id); return send(200, { exists: !!d, data: d }); }
        if (m === 'PUT') {
          const data = await readJson(MAX_DOC + 1024);
          if (!isObj(data)) return fail(400, 'Body must be a JSON object.');
          if (c === 'approvals') { data.by = user.id; data.at = new Date().toISOString(); }
          const bad = await checkWrite(user, c, id, data, false);
          if (bad) return fail(bad[0], bad[1]);
          if (JSON.stringify(data).length > MAX_DOC) return fail(413, 'Record is too large.');
          await store.putDoc(c, id, data, user.id);
          await store.audit(user.id, 'put', c, id);
          return send(200, { ok: true });
        }
        if (m === 'DELETE') {
          const bad = await checkWrite(user, c, id, {}, true);
          if (bad) return fail(bad[0], bad[1]);
          await store.deleteDoc(c, id);
          await store.audit(user.id, 'delete', c, id);
          return send(200, { ok: true });
        }
      }
      if (p === '/api/batch' && m === 'POST') {
        const b = await readJson();
        const w = b.writes;
        if (!Array.isArray(w) || !w.length || w.length > 200) return fail(400, 'Send between 1 and 200 writes.');
        const memo = new Map();
        for (const x of w) {
          if (!x || !BATCH_OK.has(x.c) || !ID_RE.test(String(x.id)) || (x.op !== 'set' && x.op !== 'delete')) return fail(400, 'Invalid write in batch.');
          if (x.op === 'set' && (!isObj(x.data) || JSON.stringify(x.data).length > MAX_DOC)) return fail(400, 'Invalid record in batch.');
          const bad = await checkWrite(user, x.c, String(x.id), x.data || {}, x.op === 'delete', memo);
          if (bad) return fail(bad[0], bad[1]);
        }
        await store.batch(w.map((x) => ({ op: x.op, c: x.c, id: String(x.id), data: x.data })), user.id);
        await store.audit(user.id, 'batch', w[0].c, String(w.length));
        return send(200, { ok: true });
      }

      /* ----- manager tools ----- */
      if (p === '/api/export' && m === 'GET') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can export data.');
        await store.audit(user.id, 'export');
        return send(200, { app: 'pfss-payroll', version: 1, exportedAt: new Date().toISOString(), docs: await store.allDocs() });
      }
      if (p === '/api/restore' && m === 'POST') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can restore data.');
        const b = await readJson();
        if (!b || b.app !== 'pfss-payroll' || !Array.isArray(b.docs)) return fail(400, 'This is not a PFSS payroll backup file.');
        for (const d of b.docs) {
          if (!d || !COLLECTIONS.has(d.collection) || !ID_RE.test(String(d.id)) || !isObj(d.data)) return fail(400, 'The backup file contains invalid records.');
        }
        await store.restore(b.docs.map((d) => ({ collection: d.collection, id: String(d.id), data: d.data })), user.id);
        await store.audit(user.id, 'restore');
        return send(200, { ok: true, count: b.docs.length });
      }
      if (p === '/api/wipe' && m === 'POST') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can delete data.');
        await store.wipe();
        await store.audit(user.id, 'wipe');
        return send(200, { ok: true });
      }
      if (p === '/api/seed-sample' && m === 'POST') {
        if (user.role !== 'manager') return fail(403, 'Only a manager can load sample data.');
        if ((await store.docCount()) > 0) return fail(409, 'Sample data can only be loaded into an empty database.');
        const sample = await sampleData();
        await store.batch(sample.ops, user.id);
        await store.audit(user.id, 'seed-sample');
        return send(200, { ok: true, month: sample.month });
      }
      return fail(404, 'Not found.');
    } catch (e) {
      if (e && e.code && e.msg) return fail(e.code, e.msg);
      console.error(e);
      return fail(500, 'Something went wrong on the server.');
    }
  };
}

/* ---------- sample data (previous month) ---------- */
async function sampleData() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  const month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const D = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const ops = [];
  const put = (c, id, data) => ops.push({ op: 'set', c, id, data });
  put('sites', 's1', { name: 'Apex Logistics Park', client: 'Apex Supply Chain Pvt Ltd', city: 'Hosur' });
  put('sites', 's2', { name: 'Meridian Mall', client: 'Meridian Retail Group', city: 'Bengaluru' });
  put('sites', 's3', { name: 'Orion Tech Campus', client: 'Orion Systems', city: 'Chennai' });
  const E = (i, name, desig, siteId, basic, hra, other, esi, uan, esiNo, acct, ifsc, bankName) => put('employees', 'e' + i, {
    code: 'PFS-' + String(i).padStart(4, '0'), name, phone: '', desig, doj: '2024-04-01', siteId, basic, hra, other, pf: true, esi, uan, esiNo, bankName, acct, ifsc, active: true });
  E(1, 'Ramesh Kumar', 'Security guard', 's1', 12000, 3000, 2500, true, '100234567891', '3100456781', '50100234567', 'HDFC0001234', 'HDFC Bank');
  E(2, 'Sunita Devi', 'Housekeeping', 's2', 11000, 2750, 2000, true, '100234567892', '3100456782', '50100234568', 'HDFC0001234', 'HDFC Bank');
  E(3, 'Mohammed Irfan', 'Site supervisor', 's1', 18000, 6000, 5000, false, '100234567893', '', '31200345678', 'SBIN0004321', 'State Bank of India');
  E(4, 'Lakshmi Narayanan', 'Security guard', 's3', 12500, 3125, 2500, true, '100234567894', '3100456784', '60400123456', 'ICIC0000987', 'ICICI Bank');
  E(5, 'Anita Joseph', 'Facility executive', 's3', 22000, 8000, 7000, false, '100234567895', '', '60400123457', 'ICIC0000987', 'ICICI Bank');
  E(6, 'Dinesh Babu', 'Electrician', 's2', 14000, 3500, 3000, true, '100234567896', '3100456786', '31200345679', 'SBIN0004321', 'State Bank of India');
  E(7, 'Priya Shankar', 'Housekeeping', 's1', 10500, 2625, 1875, true, '', '3100456787', '50100234569', 'HDFC0001234', 'HDFC Bank');
  E(8, 'Karthik Raja', 'Security guard', 's2', 12000, 3000, 2500, true, '100234567898', '3100456788', '60400123458', 'ICIC0000987', 'ICICI Bank');
  const A = (i, l, u, a, ot, night, od, note) => put('attendance', month + '_e' + i, {
    month, empId: 'e' + i, present: D - l - u - a, paidLeave: l, unpaidLeave: u, absent: a, ot, night, otherDed: od || 0, note: note || '' });
  A(1, 1, 1, 0, 12, 6); A(2, 0, 0, 0, 0, 0); A(3, 1, 0, 0, 8, 0); A(4, 1, 0, 2, 10, 8, 500, 'Salary advance recovery');
  A(5, 0, 0, 0, 0, 0); A(6, 0, 2, 0, 6, 0); A(7, 2, 0, 2, 0, 0); A(8, 0, 0, 0, 16, 10);
  return { ops, month };
}
