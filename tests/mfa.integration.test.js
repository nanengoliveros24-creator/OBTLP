/*
  Email OTP (multi-factor sign-in). Boots the server with MFA_DEV_LOG=1 so
  codes are printed to the server's stdout instead of emailed, then reads
  them from there.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

let server;
before(async () => { server = await startServer({ mfa: true }); });
after(async () => { if (server) await server.stop(); });

function lastCode(email) {
  const re = new RegExp(`${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{6})`, 'g');
  const all = [...server.output().matchAll(re)];
  return all.length ? all[all.length - 1][1] : null;
}

async function waitForCode(email) {
  for (let i = 0; i < 20; i++) {
    const c = lastCode(email);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('password alone no longer signs in; the emailed code does', async () => {
  const c = makeClient(server.baseUrl);
  await c.post('/api/register', { name: 'Mfa User', username: 'mfa.user@gmail.com', password: 'secret1', confirmPassword: 'secret1', role: 'faculty' });

  const step1 = await c.post('/api/login', { username: 'mfa.user@gmail.com', password: 'secret1', role: 'faculty' });
  assert.equal(step1.status, 200);
  assert.equal(step1.data.mfaRequired, true);
  assert.equal(step1.data.token, undefined, 'no session before the code is entered');
  assert.match(step1.data.maskedEmail, /^mf\*+@gmail\.com$/);

  const wrong = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code: '000000' });
  assert.equal(wrong.status, 400);

  const code = await waitForCode('mfa.user@gmail.com');
  assert.ok(code, 'code was issued');
  const ok = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);

  const reuse = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code });
  assert.equal(reuse.status, 400, 'a code works only once');
});

test('too many wrong codes ends the sign-in attempt', async () => {
  const c = makeClient(server.baseUrl);
  const step1 = await c.post('/api/login', { username: 'mfa.user@gmail.com', password: 'secret1' });
  let last;
  for (let i = 0; i < 5; i++) {
    last = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code: `11111${i}` });
  }
  assert.equal(last.data.restart, true);
  const after5 = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code: lastCode('mfa.user@gmail.com') });
  assert.equal(after5.status, 400);
});

test('accounts without an email add one, verified by a code, before signing in', async () => {
  const c = makeClient(server.baseUrl);
  await c.post('/api/register', { name: 'No Mail', username: 'nomail', password: 'secret1', confirmPassword: 'secret1', role: 'faculty' });
  const step1 = await c.post('/api/login', { username: 'nomail', password: 'secret1' });
  assert.equal(step1.data.emailRequired, true);

  const bad = await c.post('/api/login/email', { challengeId: step1.data.challengeId, email: 'not-an-email' });
  assert.equal(bad.status, 400);
  const taken = await c.post('/api/login/email', { challengeId: step1.data.challengeId, email: 'mfa.user@gmail.com' });
  assert.equal(taken.status, 409);

  const sent = await c.post('/api/login/email', { challengeId: step1.data.challengeId, email: 'nomail.owner@gmail.com' });
  assert.equal(sent.data.mfaRequired, true);
  const code = await waitForCode('nomail.owner@gmail.com');
  const ok = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email, 'nomail.owner@gmail.com');
});

test('resend is rate-limited', async () => {
  const c = makeClient(server.baseUrl);
  const step1 = await c.post('/api/login', { username: 'mfa.user@gmail.com', password: 'secret1' });
  const again = await c.post('/api/login/resend', { challengeId: step1.data.challengeId });
  assert.equal(again.status, 429);
});
