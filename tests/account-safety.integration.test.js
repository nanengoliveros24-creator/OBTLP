/*
  Validator feedback (Oct 2026):
  - Public sign-up must not create IT/College Administrator accounts; a
    built-in IT Administrator exists from DEFAULT_IT_EMAIL/PASSWORD.
  - Deleting an account needs a deliberate confirmation.
  - College Administrators shouldn't see other users' account details.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');
const { applyDefaultItAdmin } = require('../seed-admin');

const IT_EMAIL = 'it.office@test.edu';
const IT_PASS = 'itpass123';

let server;
before(async () => {
  server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS, DEFAULT_IT_NAME: 'IT Office' } });
});
after(async () => { if (server) await server.stop(); });

async function signIn(username, password) {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `sign-in as ${username}`);
  c.setToken(r.data.token);
  return { c, user: r.data.user };
}

test('the default IT Administrator exists and can sign in as IT', async () => {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username: IT_EMAIL, password: IT_PASS, role: 'it' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'it');
  assert.equal(r.data.user.isDefaultAdmin, true);
});

test('sign-up only makes faculty accounts and needs an email', async () => {
  const c = makeClient(server.baseUrl);
  const sneaky = await c.post('/api/register', { name: 'Wants IT', username: 'wants.it@test.edu', password: 'secret1', confirmPassword: 'secret1', role: 'it' });
  assert.equal(sneaky.status, 201);
  assert.equal(sneaky.data.user.role, 'faculty', 'a requested role is ignored');

  const asAdmin = await c.post('/api/login', { username: 'wants.it@test.edu', password: 'secret1', role: 'it' });
  assert.equal(asAdmin.status, 401);

  const noEmail = await c.post('/api/register', { name: 'No Email', username: 'justname', password: 'secret1', confirmPassword: 'secret1' });
  assert.equal(noEmail.status, 400);

  const dupe = await c.post('/api/register', { name: 'Dupe', username: 'WANTS.IT@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  assert.equal(dupe.status, 409);
});

test('deleting an account needs the typed username and the IT password', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const pub = makeClient(server.baseUrl);
  const reg = await pub.post('/api/register', { name: 'Leaving Soon', username: 'leaving@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  const victimId = reg.data.user.id;
  const { c: victim } = await signIn('leaving@test.edu', 'secret1');
  await victim.post('/api/portfolios');

  const noConfirm = await it.del(`/api/users/${victimId}`, {});
  assert.equal(noConfirm.status, 400);
  const wrongName = await it.del(`/api/users/${victimId}`, { confirmUsername: 'someone@else', password: IT_PASS });
  assert.equal(wrongName.status, 400);
  const wrongPass = await it.del(`/api/users/${victimId}`, { confirmUsername: 'leaving@test.edu', password: 'nope-nope' });
  assert.equal(wrongPass.status, 403, 'wrong password is 403 so the IT admin is not signed out');

  const ok = await it.del(`/api/users/${victimId}`, { confirmUsername: 'leaving@test.edu', password: IT_PASS });
  assert.equal(ok.status, 200);

  const after = await victim.get('/api/state');
  assert.equal(after.status, 401, 'removed user is signed out');

  const state = await it.get('/api/state');
  assert.ok(state.data.allPortfolios.some((p) => p.facultyId === victimId), 'their portfolio is kept for records');
  assert.ok(state.data.auditLogs.some((l) => l.action === 'user-delete' && /leaving@test.edu/.test(l.detail)));
});

test('the default IT Administrator is protected from other IT admins', async () => {
  const { c: it, user: itUser } = await signIn(IT_EMAIL, IT_PASS);
  const made = await it.post('/api/users', { name: 'Second IT', username: 'second.it@test.edu', role: 'it', password: 'second123' });
  assert.equal(made.status, 201);
  assert.equal((await it.post('/api/users', { name: 'X', username: 'not-an-email', role: 'faculty' })).status, 400);

  const { c: it2 } = await signIn('second.it@test.edu', 'second123');
  assert.equal((await it2.del(`/api/users/${itUser.id}`, { confirmUsername: IT_EMAIL, password: 'second123' })).status, 403);
  assert.equal((await it2.put(`/api/users/${itUser.id}`, { role: 'faculty' })).status, 403);
  assert.equal((await it2.post(`/api/users/${itUser.id}/password`, { newPassword: 'hijacked1' })).status, 403);

  // The default admin can still manage the other one.
  assert.equal((await it.put(`/api/users/${made.data.id}`, { role: 'admin' })).status, 200);
  const relog = await it2.get('/api/state');
  assert.equal(relog.status, 401, 'a role change signs them out so the new role applies');
});

test('seeding the default IT account is safe to repeat on every restart', () => {
  const store = { nextId: (p) => `${p}_1`, nowIso: () => new Date().toISOString() };
  const db = { users: [] };
  applyDefaultItAdmin(db, { DEFAULT_IT_EMAIL: 'a@b.co', DEFAULT_IT_PASSWORD: 'pw12345' }, store);
  assert.equal(db.users.length, 1);
  const hash = db.users[0].passwordHash;
  // A later restart never resets a password the owner already changed.
  applyDefaultItAdmin(db, { DEFAULT_IT_EMAIL: 'a@b.co', DEFAULT_IT_PASSWORD: 'different1' }, store);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].passwordHash, hash);
  // An existing account named by DEFAULT_IT_EMAIL is promoted, not duplicated.
  const db2 = { users: [{ id: 'u1', username: 'Boss@B.co', role: 'faculty', passwordHash: 'x' }] };
  applyDefaultItAdmin(db2, { DEFAULT_IT_EMAIL: 'boss@b.co', DEFAULT_IT_PASSWORD: 'pw12345' }, store);
  assert.equal(db2.users.length, 1);
  assert.equal(db2.users[0].role, 'it');
  assert.equal(db2.users[0].passwordHash, 'x');
});

test('a College Administrator sees only names of other users, not their accounts', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  await it.post('/api/users', { name: 'Dean Reviewer', username: 'dean@test.edu', role: 'admin', password: 'deanpass1' });
  const { c: admin, user } = await signIn('dean@test.edu', 'deanpass1');
  const state = await admin.get('/api/state');
  const others = state.data.users.filter((u) => u.id !== user.id);
  assert.ok(others.length > 0);
  others.forEach((u) => {
    assert.deepEqual(Object.keys(u).sort(), ['id', 'name', 'role']);
  });
  const me = state.data.users.find((u) => u.id === user.id);
  assert.equal(me.username, 'dean@test.edu', 'own profile is still complete');
});
