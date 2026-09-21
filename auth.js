/*
  Password hashing + session token helpers.
  Uses Node's built-in crypto module only (no external dependencies).

  Passwords are stored as "salt:hash" (scrypt, per-user random salt).
  Session tokens are opaque random strings looked up against db.sessions.
*/
const crypto = require('crypto');

const KEY_LEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const testBuffer = crypto.scryptSync(String(password), salt, KEY_LEN);
    if (hashBuffer.length !== testBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, testBuffer);
  } catch (e) {
    return false;
  }
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function newSession(userId) {
  const now = Date.now();
  return {
    token: makeToken(),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
}

function isExpired(session) {
  if (!session || !session.expiresAt) return true;
  return new Date(session.expiresAt).getTime() < Date.now();
}

module.exports = { hashPassword, verifyPassword, makeToken, newSession, isExpired, SESSION_TTL_MS };
