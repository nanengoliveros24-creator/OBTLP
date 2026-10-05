/*
  Strong passwords (Oct 2026): every new password needs at least 8
  characters with an uppercase letter, a lowercase letter, a number and a
  special character — at sign-up, first-run setup, Profile → Change
  Password, and when an IT Administrator creates or resets an account.
  Older accounts with a weak password can still sign in, but are flagged
  (passwordWeak) so the app asks them to change it.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, makeClient } = require('./helpers');
const policy = require('../password-policy');
const auth = require('../auth');

const IT_EMAIL = 'it.office@test.edu';
const IT_PASS = 'ItPass#123';

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

test('the password rules', () => {
  assert.equal(policy.isStrong('Secret#01'), true);
  assert.equal(policy.isStrong('Sec#01'), false, 'too short');
  assert.equal(policy.isStrong('secret#01'), false, 'no uppercase');
  assert.equal(policy.isStrong('SECRET#01'), false, 'no lowercase');
  assert.equal(policy.isStrong('Secret#ab'), false, 'no number');
  assert.equal(policy.isStrong('Secret001'), false, 'no special character');
  assert.equal(policy.isStrong(''), false);
  for (let i = 0; i < 50; i++) {
    const g = policy.generate((n) => require('crypto').randomInt(n), 12);
    assert.equal(g.length, 12);
    assert.ok(policy.isStrong(g), `generated ${g} passes`);
  }
});

test('sign-up rejects weak passwords and accepts a strong one', async () => {
  const c = makeClient(server.baseUrl);
  const reg = (pw) => c.post('/api/register', { name: 'New Prof', username: 'new.prof@test.edu', password: pw, confirmPassword: pw, departmentId: 'CCS' });
  for (const weak of ['secret1', 'password', 'Password1', 'password#1', 'Pass#1']) {
    const r = await reg(weak);
    assert.equal(r.status, 400, `${weak} is rejected`);
    assert.match(r.data.error || r.data.message || '', /8 characters/);
  }
  assert.equal((await reg('Secret#01')).status, 201);
});

test('Profile → Change Password needs a strong, different new password', async () => {
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Changer', username: 'changer@test.edu', password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CCS' });
  const { c } = await signIn('changer@test.edu', 'Secret#01');
  assert.equal((await c.post('/api/me/password', { currentPassword: 'Secret#01', newPassword: 'weakpass' })).status, 400);
  assert.equal((await c.post('/api/me/password', { currentPassword: 'Secret#01', newPassword: 'Secret#01' })).status, 400, 'same as before');
  assert.equal((await c.post('/api/me/password', { currentPassword: 'Secret#01', newPassword: 'Changed#02' })).status, 200);
});

test('IT Administrator: typed passwords must be strong; a blank one is generated strong', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const weak = await it.post('/api/users', { name: 'Weak', username: 'weak@test.edu', role: 'faculty', password: 'abc12345' });
  assert.equal(weak.status, 400);
  const auto = await it.post('/api/users', { name: 'Auto', username: 'auto@test.edu', role: 'faculty' });
  assert.equal(auto.status, 201);
  assert.ok(policy.isStrong(auto.data.temporaryPassword), 'auto-generated password is strong');
  await signIn('auto@test.edu', auto.data.temporaryPassword);

  assert.equal((await it.post(`/api/users/${auto.data.id}/password`, { newPassword: 'short1' })).status, 400);
  assert.equal((await it.post(`/api/users/${auto.data.id}/password`, { newPassword: 'Reset#Pass9' })).status, 200);
  await signIn('auto@test.edu', 'Reset#Pass9');
});

test('an older account with a weak password can sign in but is flagged until it changes it', async () => {
  const dbFile = path.join(server.dir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.users.push({ id: 'u_old', name: 'Old Timer', username: 'old.timer@test.edu', email: 'old.timer@test.edu', role: 'faculty', passwordHash: auth.hashPassword('oldpw1') });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

  const { c, user } = await signIn('old.timer@test.edu', 'oldpw1');
  assert.equal(user.passwordWeak, true);
  assert.equal(user.passwordHash, undefined);
  assert.equal((await c.post('/api/me/password', { currentPassword: 'oldpw1', newPassword: 'Stronger#1' })).status, 200);
  const again = await signIn('old.timer@test.edu', 'Stronger#1');
  assert.equal(again.user.passwordWeak, undefined);
  const stored = JSON.parse(fs.readFileSync(dbFile, 'utf8')).users.find((u) => u.id === 'u_old');
  assert.equal(stored.passwordWeak, undefined);
  assert.ok(!JSON.stringify(stored).includes('Stronger#1'), 'the password itself is never stored');
});

test('first-run setup also needs a strong password', async () => {
  const fresh = await startServer();
  try {
    const c = makeClient(fresh.baseUrl);
    assert.equal((await c.post('/api/setup', { name: 'Root', username: 'root', password: 'rootpass', role: 'it' })).status, 400);
    assert.equal((await c.post('/api/setup', { name: 'Root', username: 'root', password: 'Root#Pass1', role: 'it' })).status, 201);
  } finally {
    await fresh.stop();
  }
});

test('seeding the default IT account needs a strong DEFAULT_IT_PASSWORD', () => {
  const { applyDefaultItAdmin } = require('../seed-admin');
  const store = { nextId: (p) => `${p}_1`, nowIso: () => new Date().toISOString() };
  const weakDb = { users: [] };
  applyDefaultItAdmin(weakDb, { DEFAULT_IT_EMAIL: 'a@b.co', DEFAULT_IT_PASSWORD: 'pw12345678' }, store);
  assert.equal(weakDb.users.length, 0);
  const okDb = { users: [] };
  applyDefaultItAdmin(okDb, { DEFAULT_IT_EMAIL: 'a@b.co', DEFAULT_IT_PASSWORD: 'Pw#12345' }, store);
  assert.equal(okDb.users.length, 1);
});
