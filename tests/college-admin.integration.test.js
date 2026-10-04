/*
  College Administrator review queue: deleting a submission needs a typed
  confirmation and notifies the faculty member; faculty "last active" is
  visible so the admin can see who is active.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

const IT_EMAIL = 'it@test.edu';
const IT_PASS = 'itpass123';
let server;
before(async () => { server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS } }); });
after(async () => { if (server) await server.stop(); });

async function signIn(username, password) {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `sign-in as ${username}`);
  c.setToken(r.data.token);
  return { c, user: r.data.user };
}

test('a College Administrator can delete a submission only with the typed course code', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  await it.post('/api/users', { name: 'Dean', username: 'dean@test.edu', role: 'admin', password: 'deanpass1' });
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Grace T', username: 'grace@test.edu', password: 'secret1', confirmPassword: 'secret1', departmentId: 'CCS' });

  const { c: fac, user: facUser } = await signIn('grace@test.edu', 'secret1');
  const draft = await fac.post('/api/portfolios');
  await fac.put(`/api/portfolios/${draft.data.id}`, { courseCode: 'ITP 100', courseTitle: 'System Analysis Design', academicYear: '2026-2027' });

  const { c: admin } = await signIn('dean@test.edu', 'deanpass1');
  assert.equal((await admin.del(`/api/portfolios/${draft.data.id}`, { confirmCourseCode: 'ITP 100' })).status, 409, 'drafts stay the faculty member\'s');

  await fac.post(`/api/portfolios/${draft.data.id}/actions`, { action: 'submit' });
  assert.equal((await admin.del(`/api/portfolios/${draft.data.id}`, {})).status, 400);
  assert.equal((await admin.del(`/api/portfolios/${draft.data.id}`, { confirmCourseCode: 'ITP 999' })).status, 400);
  const ok = await admin.del(`/api/portfolios/${draft.data.id}`, { confirmCourseCode: 'itp 100', reason: 'Test entry' });
  assert.equal(ok.status, 200);

  const facState = await fac.get('/api/state');
  assert.ok(!facState.data.portfolios.some((p) => p.id === draft.data.id));
  assert.ok(facState.data.notifications.some((n) => n.userId === facUser.id && /ITP 100/.test(n.message) && /Test entry/.test(n.message)));

  // IT can't use this path (it's the review office's call).
  const another = await fac.post('/api/portfolios');
  await fac.put(`/api/portfolios/${another.data.id}`, { courseCode: 'CCS101', courseTitle: 'Intro', academicYear: '2026-2027' });
  await fac.post(`/api/portfolios/${another.data.id}/actions`, { action: 'submit' });
  assert.equal((await it.del(`/api/portfolios/${another.data.id}`, { confirmCourseCode: 'CCS101' })).status, 403);
});

test('the College Administrator sees when each faculty member last signed in', async () => {
  const { c: admin } = await signIn('dean@test.edu', 'deanpass1');
  const state = await admin.get('/api/state');
  const grace = state.data.users.find((u) => u.name === 'Grace T');
  assert.ok(grace.lastActiveAt, 'last sign-in is shown');
  assert.equal(grace.username, undefined, 'but not their account details');
});
