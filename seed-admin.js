/*
  Built-in IT Administrator account.

  Public sign-up only creates Faculty accounts, so the system needs an IT
  Administrator that exists from the start. On every server start this
  makes sure the account named by these environment variables exists:

    DEFAULT_IT_EMAIL     its email/username (a real inbox — sign-in codes go there)
    DEFAULT_IT_PASSWORD  its password the first time it is created
    DEFAULT_IT_NAME      optional display name (default "IT Administrator")

  Set them in Render → Environment (never commit them). Behaviour:
  - Account missing      → created as IT Administrator with that password.
  - Account already there → made IT Administrator if it wasn't; its
    password is NOT touched (change it from Profile), so a later restart
    never undoes a password change.
  - It is marked isDefaultAdmin: other IT Administrators can't delete it,
    demote it, or reset its password.
  With the variables unset nothing happens (local dev keeps the first-run
  setup page on an empty database).
*/
const auth = require('./auth');
const passwordPolicy = require('./password-policy');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function applyDefaultItAdmin(db, env, store) {
  const email = String(env.DEFAULT_IT_EMAIL || '').trim().toLowerCase();
  const password = String(env.DEFAULT_IT_PASSWORD || '');
  const name = String(env.DEFAULT_IT_NAME || '').trim() || 'IT Administrator';
  if (!email) return { changed: false, note: 'DEFAULT_IT_EMAIL not set — skipped' };
  if (!EMAIL_RE.test(email)) return { changed: false, note: 'DEFAULT_IT_EMAIL is not a valid email — skipped' };

  if (!db.users) db.users = [];
  let changed = false;
  const matches = (u) => String(u.username || '').toLowerCase() === email || String(u.email || '').toLowerCase() === email;

  // Only one account carries the flag (in case DEFAULT_IT_EMAIL changed).
  db.users.forEach((u) => {
    if (u.isDefaultAdmin && !matches(u)) { delete u.isDefaultAdmin; changed = true; }
  });

  const existing = db.users.find(matches);
  if (existing) {
    if (existing.role !== 'it') { existing.role = 'it'; changed = true; }
    if (!existing.isDefaultAdmin) { existing.isDefaultAdmin = true; changed = true; }
    if (!existing.email) { existing.email = email; changed = true; }
    return { changed, note: changed ? `updated default IT Administrator ${email}` : 'default IT Administrator already set up' };
  }

  if (!passwordPolicy.isStrong(password)) {
    return { changed, note: 'DEFAULT_IT_PASSWORD missing or too weak (needs 8+ characters with uppercase, lowercase, number and special character) — account not created' };
  }
  const user = {
    id: store.nextId('u'),
    name,
    username: email,
    email,
    role: 'it',
    isDefaultAdmin: true,
    createdVia: 'default',
    passwordHash: auth.hashPassword(password)
  };
  db.users.push(user);
  if (!db.auditLogs) db.auditLogs = [];
  db.auditLogs.unshift({
    id: store.nextId('log'),
    at: store.nowIso(),
    actor: user.id,
    action: 'user-create',
    portfolioId: null,
    detail: `Created default IT Administrator account ${email}`
  });
  return { changed: true, note: `created default IT Administrator ${email}` };
}

async function ensureDefaultItAdmin(store, env) {
  env = env || process.env;
  try {
    const db = await store.readDb();
    const { changed, note } = applyDefaultItAdmin(db, env, store);
    if (changed) await store.writeDb(db);
    console.log(`[seed-admin] ${note}`);
    if (!(db.users || []).some((u) => u.role === 'it')) {
      console.warn('[seed-admin] WARNING: there is no IT Administrator account. Set DEFAULT_IT_EMAIL and DEFAULT_IT_PASSWORD.');
    }
  } catch (err) {
    // Never block the server from starting because of this.
    console.error('[seed-admin] failed:', err && err.message ? err.message : err);
  }
}

module.exports = { ensureDefaultItAdmin, applyDefaultItAdmin };
