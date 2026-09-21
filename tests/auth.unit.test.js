/*
  Unit tests for auth.js. No server, no filesystem — pure function checks.
  Run: node --test tests/auth.unit.test.js
*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../auth');

test('hashPassword produces a salt:hash pair, never the raw password', () => {
  const stored = auth.hashPassword('correct horse battery staple');
  assert.ok(stored.includes(':'));
  assert.ok(!stored.includes('correct horse battery staple'));
});

test('verifyPassword accepts the correct password', () => {
  const stored = auth.hashPassword('mySecret123');
  assert.equal(auth.verifyPassword('mySecret123', stored), true);
});

test('verifyPassword rejects a wrong password', () => {
  const stored = auth.hashPassword('mySecret123');
  assert.equal(auth.verifyPassword('wrongGuess', stored), false);
});

test('verifyPassword rejects malformed/missing stored hashes instead of throwing', () => {
  assert.equal(auth.verifyPassword('anything', null), false);
  assert.equal(auth.verifyPassword('anything', ''), false);
  assert.equal(auth.verifyPassword('anything', 'not-a-valid-hash'), false);
});

test('two hashes of the same password are different (random salt)', () => {
  const a = auth.hashPassword('sameInput');
  const b = auth.hashPassword('sameInput');
  assert.notEqual(a, b);
  assert.equal(auth.verifyPassword('sameInput', a), true);
  assert.equal(auth.verifyPassword('sameInput', b), true);
});

test('newSession issues a token and an expiry in the future', () => {
  const session = auth.newSession('user_1');
  assert.ok(session.token.length > 0);
  assert.ok(new Date(session.expiresAt).getTime() > Date.now());
});

test('isExpired is true for a session already past its expiresAt', () => {
  const pastSession = { expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(auth.isExpired(pastSession), true);
});

test('isExpired is false for a freshly issued session', () => {
  const session = auth.newSession('user_1');
  assert.equal(auth.isExpired(session), false);
});

test('isExpired treats a missing/malformed session as expired (fail closed)', () => {
  assert.equal(auth.isExpired(null), true);
  assert.equal(auth.isExpired({}), true);
});
