// Run with: npm test   (Node 22.13+; uses in-memory SQLite instead of Netlify Database)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../netlify/lib/core.mjs';
import { createStore } from '../netlify/lib/store.mjs';
import { sqliteAdapter } from '../netlify/lib/sqlite-adapter.mjs';

process.env.SETUP_KEY = 'k-test';
const handle = createApi({ store: createStore(sqliteAdapter()) });
const jars = {};
async function call(who, method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-pfss': '1' };
  if (jars[who]) headers.cookie = jars[who];
  const r = await handle(new Request('http://localhost' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), { ip: who });
  const sc = r.headers.getSetCookie?.()[0];
  if (sc) jars[who] = sc.split(';')[0];
  return { status: r.status, body: await r.json() };
}
const att = (month, id) => ({ month, empId: id, present: 30, paidLeave: 0, unpaidLeave: 0, absent: 0, ot: 0, night: 0, otherDed: 0, note: '' });

test('setup needs the key, works once', async () => {
  assert.equal((await call('m', 'POST', '/api/setup', { setupKey: 'bad', name: 'M', username: 'mgr', password: 'password123' })).status, 403);
  assert.equal((await call('m', 'POST', '/api/setup', { setupKey: 'k-test', name: 'M', username: 'mgr', password: 'password123' })).status, 200);
  assert.equal((await call('x', 'POST', '/api/setup', { setupKey: 'k-test', name: 'X', username: 'xx1', password: 'password123' })).status, 409);
});
test('roles are enforced', async () => {
  await call('m', 'POST', '/api/users', { name: 'P', username: 'pay', role: 'payroll', password: 'password123' });
  await call('m', 'POST', '/api/users', { name: 'V', username: 'view', role: 'viewer', password: 'password123' });
  await call('p', 'POST', '/api/login', { username: 'pay', password: 'password123' });
  await call('v', 'POST', '/api/login', { username: 'view', password: 'password123' });
  assert.equal((await call('v', 'PUT', '/api/d/sites/s1', { name: 'x' })).status, 403);
  assert.equal((await call('p', 'PUT', '/api/d/sites/s1', { name: 'Site' })).status, 200);
  assert.equal((await call('p', 'PUT', '/api/d/config/settings', { pfRate: 1 })).status, 403);
  assert.equal((await call('p', 'POST', '/api/users', { name: 'Z', username: 'zzz', role: 'manager', password: 'password123' })).status, 403);
  assert.equal((await call('x2', 'GET', '/api/me')).status, 401);
});
test('batch writes, pulse changes, month queries', async () => {
  const before = (await call('p', 'GET', '/api/pulse')).body.attendance || 0;
  const w = ['e1', 'e2', 'e3'].map((e) => ({ op: 'set', c: 'attendance', id: '2026-09_' + e, data: att('2026-09', e) }));
  assert.equal((await call('p', 'POST', '/api/batch', { writes: w })).status, 200);
  assert.ok((await call('p', 'GET', '/api/pulse')).body.attendance > before);
  assert.equal((await call('p', 'GET', '/api/c/attendance?month=2026-09')).body.length, 3);
  assert.equal((await call('p', 'GET', '/api/c/attendance?month=2026-10')).body.length, 0);
  assert.equal((await call('p', 'POST', '/api/batch', { writes: [{ op: 'set', c: 'config', id: 's', data: {} }] })).status, 400);
});
test('approval needs a validated, submitted payroll; then the month locks', async () => {
  const ap = (stamp) => call('m', 'PUT', '/api/d/approvals/2026-09', { decision: 'approved', stamp });
  assert.equal((await call('p', 'PUT', '/api/d/approvals/2026-09', { decision: 'approved', stamp: '1' })).status, 403);
  assert.equal((await ap('1')).status, 409);
  await call('p', 'PUT', '/api/d/runs/2026-09', { hasCalc: true, stamp: '1', validated: true, submitted: true, log: [] });
  assert.equal((await ap('999')).status, 409);
  assert.equal((await ap('1')).status, 200);
  assert.equal((await call('p', 'PUT', '/api/d/attendance/2026-09_e1', att('2026-09', 'e1'))).status, 409);
  await call('p', 'PUT', '/api/d/runs/2026-09', { hasCalc: true, stamp: '1', validated: true, finalized: true, log: [] });
  assert.equal((await call('p', 'PUT', '/api/d/runs/2026-09', { hasCalc: false, log: [] })).status, 409);
  assert.equal((await call('p', 'PUT', '/api/d/runlines/2026-09_e1', { month: '2026-09' })).status, 409);
});
test('sign-in throttling, last manager protected, backup round trip', async () => {
  for (let i = 0; i < 5; i++) await call('bad', 'POST', '/api/login', { username: 'pay', password: 'wrong' });
  assert.equal((await call('bad', 'POST', '/api/login', { username: 'pay', password: 'password123' })).status, 429);
  const me = (await call('m', 'GET', '/api/me')).body;
  assert.equal((await call('m', 'PATCH', '/api/users/' + me.id, { role: 'viewer' })).status, 409);
  const exp = (await call('m', 'GET', '/api/export')).body;
  assert.ok(exp.docs.length > 3);
  assert.equal((await call('m', 'POST', '/api/wipe', {})).status, 200);
  assert.equal((await call('m', 'GET', '/api/c/sites')).body.length, 0);
  assert.equal((await call('m', 'POST', '/api/restore', exp)).body.count, exp.docs.length);
  assert.equal((await call('m', 'GET', '/api/c/sites')).body.length, 1);
});
