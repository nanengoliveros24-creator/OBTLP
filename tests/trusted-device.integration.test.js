/*
  "Trust this device for 30 days": after one emailed code, the same browser
  signs in with just the password; changing the password, an admin reset,
  or "Forget all" turns that off.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

let server;
before(async () => { server = await startServer({ mfa: true }); });
after(async () => { if (server) await server.stop(); });

async function codeFor(email) {
  const re = new RegExp(`${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{6})`, 'g');
  for (let i = 0; i < 40; i++) {
    const all = [...server.output().matchAll(re)];
    if (all.length) return all[all.length - 1][1];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function signInWithCode(c, email, password, trustDevice, deviceToken) {
  const step1 = await c.post('/api/login', { username: email, password, deviceToken });
  assert.equal(step1.status, 200);
  if (step1.data.token) return step1.data;
  assert.equal(step1.data.mfaRequired, true);
  const code = await codeFor(email);
  const ok = await c.post('/api/login/verify', { challengeId: step1.data.challengeId, code, trustDevice });
  assert.equal(ok.status, 200);
  return ok.data;
}

test('a trusted device skips the code but still needs the password', async () => {
  const c = makeClient(server.baseUrl);
  await c.post('/api/register', { name: 'Trusty', username: 'trusty@test.edu', password: 'secret1', confirmPassword: 'secret1' });

  const first = await signInWithCode(c, 'trusty@test.edu', 'secret1', true);
  assert.ok(first.deviceToken, 'a device token is issued when trust is ticked');
  assert.equal(first.user.trustedDevices, undefined, 'device secrets are never sent to the browser');
  assert.equal(first.user.trustedDeviceCount, 1);

  const again = await c.post('/api/login', { username: 'trusty@test.edu', password: 'secret1', deviceToken: first.deviceToken });
  assert.equal(again.status, 200);
  assert.ok(again.data.token, 'signed in straight away');
  assert.equal(again.data.trustedDevice, true);

  const wrongPw = await c.post('/api/login', { username: 'trusty@test.edu', password: 'nope', deviceToken: first.deviceToken });
  assert.equal(wrongPw.status, 401, 'the password is still required');

  const otherBrowser = await c.post('/api/login', { username: 'trusty@test.edu', password: 'secret1', deviceToken: 'made-up-token' });
  assert.equal(otherBrowser.data.mfaRequired, true, 'an unknown device still gets a code');

  // Another account can't use this account's device token.
  await c.post('/api/register', { name: 'Other', username: 'other@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  const borrowed = await c.post('/api/login', { username: 'other@test.edu', password: 'secret1', deviceToken: first.deviceToken });
  assert.equal(borrowed.data.mfaRequired, true);
});

test('not ticking "trust" issues no device token', async () => {
  const c = makeClient(server.baseUrl);
  await c.post('/api/register', { name: 'Careful', username: 'careful@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  const r = await signInWithCode(c, 'careful@test.edu', 'secret1', false);
  assert.equal(r.deviceToken, undefined);
});

test('changing the password or "Forget all" ends trust', async () => {
  const c = makeClient(server.baseUrl);
  const first = await signInWithCode(c, 'trusty@test.edu', 'secret1', true);
  c.setToken(first.token);

  const list = await c.get('/api/me/trusted-devices');
  assert.ok(list.data.length >= 1);
  assert.equal(list.data[0].tokenHash, undefined);

  const forget = await c.del('/api/me/trusted-devices');
  assert.equal(forget.status, 200);
  const after1 = await c.post('/api/login', { username: 'trusty@test.edu', password: 'secret1', deviceToken: first.deviceToken });
  assert.equal(after1.data.mfaRequired, true);

  const second = await signInWithCode(c, 'trusty@test.edu', 'secret1', true);
  c.setToken(second.token);
  assert.equal((await c.post('/api/me/password', { currentPassword: 'secret1', newPassword: 'secret2' })).status, 200);
  const after2 = await c.post('/api/login', { username: 'trusty@test.edu', password: 'secret2', deviceToken: second.deviceToken });
  assert.equal(after2.data.mfaRequired, true, 'a new password means a new code');
});
