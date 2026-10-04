/*
  Static file server + JSON API for the OBTLP app.
  Run: node server.js
  Then open: http://localhost:3000

  All reads and writes go through dbstore.js, so faculty, admin, and IT
  views (even in different browsers) see the same data. dbstore.js stores
  that data either in MongoDB Atlas (set MONGODB_URI — used in production,
  since Render's free tier disk is wiped on every redeploy/restart) or in
  a local db.json file (no MONGODB_URI — local dev and the test suite).

  Authentication: token-based. Login/registration issue an opaque session
  token (see auth.js) that the client must send as
  "Authorization: Bearer <token>" on every request other than
  login/register/setup. The server resolves the token to a real user on
  every request and uses THAT identity for ownership/role checks -- it
  never trusts a userId/role/facultyId supplied by the client body.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./dbstore');
const auth = require('./auth');
const crypto = require('crypto');
const mailer = require('./mailer');

const ROOT = __dirname;
// Same override pattern as dbstore.js: lets tests use throwaway folders
// instead of the real uploads/backups directories.
const UPLOADS_DIR = process.env.OBTLP_UPLOADS_DIR
  ? path.resolve(process.env.OBTLP_UPLOADS_DIR)
  : path.join(ROOT, 'uploads');
const BACKUPS_DIR = process.env.OBTLP_BACKUPS_DIR
  ? path.resolve(process.env.OBTLP_BACKUPS_DIR)
  : path.join(ROOT, 'backups');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const DOC_MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const ALLOWED_DOC_EXT = Object.keys(DOC_MIME);
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15MB per file

// ---------- helpers ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  const limit = limitBytes || 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function pushAudit(db, entry) {
  if (!db.auditLogs) db.auditLogs = [];
  db.auditLogs.unshift(Object.assign({ id: store.nextId('log'), at: store.nowIso() }, entry));
  db.auditLogs = db.auditLogs.slice(0, 500);
}

function pushNotification(db, { userId, role, title, message, portfolioId }) {
  if (!db.notifications) db.notifications = [];
  db.notifications.unshift({
    id: store.nextId('note'),
    userId: userId || null,
    role: role || null,
    title,
    message,
    portfolioId: portfolioId || null,
    read: false,
    createdAt: store.nowIso()
  });
}

// Statuses that block a brand-new submission (already in the pipeline).
const BLOCKS_RESUBMIT = ['Pending Review', 'In Review', 'Approved'];
const EDITABLE_STATUSES = ['Draft', 'Revision Required'];

// The three supported roles in the system (RBAC).
const ROLES = ['faculty', 'admin', 'it'];
function isRole(role) {
  return ROLES.includes(String(role || '').toLowerCase());
}

function stripPassword(u) {
  const copy = Object.assign({}, u);
  delete copy.passwordHash;
  // Trusted-device secrets never leave the server; only how many there are.
  copy.trustedDeviceCount = activeTrustedDevices(u).length;
  delete copy.trustedDevices;
  return copy;
}

// ---------- "Trust this device" (skip the emailed code for 30 days) ----------
// After a correct sign-in code, the user can tick "Trust this device". The
// browser then keeps a random device token; the server stores only its
// SHA-256 hash. On later sign-ins from that browser the password is still
// required, but the emailed code is skipped until the token expires. All
// trusted devices are forgotten whenever the password changes, and the user
// can forget them from Profile.
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRUSTED_DEVICES = 10;

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(`device:${token}`).digest('hex');
}

function activeTrustedDevices(u) {
  const now = Date.now();
  return ((u && u.trustedDevices) || []).filter((d) => new Date(d.expiresAt).getTime() > now);
}

function deviceLabel(req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function trustDevice(user, req) {
  const token = auth.makeToken();
  const now = new Date();
  const devices = activeTrustedDevices(user);
  devices.push({
    id: store.nextId('dev'),
    tokenHash: hashDeviceToken(token),
    label: deviceLabel(req),
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TRUST_TTL_MS).toISOString()
  });
  user.trustedDevices = devices.slice(-MAX_TRUSTED_DEVICES);
  return token;
}

function findTrustedDevice(user, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const want = Buffer.from(hashDeviceToken(token), 'hex');
  return activeTrustedDevices(user).find((d) => {
    const have = Buffer.from(String(d.tokenHash || ''), 'hex');
    return have.length === want.length && crypto.timingSafeEqual(have, want);
  }) || null;
}

function forgetTrustedDevices(user) {
  if (user && user.trustedDevices && user.trustedDevices.length) user.trustedDevices = [];
}

// ---------- Email OTP (multi-factor sign-in) ----------
// After a correct password, the server emails a one-time 6-digit code to
// the account's address and only issues a session once that code is
// entered. Active whenever email delivery is configured (BREVO_API_KEY +
// MAIL_FROM, or MFA_DEV_LOG=1 locally); MFA_DISABLED=1 is an emergency
// off-switch. With neither configured (e.g. the test suite) sign-in works
// exactly as before.
const OTP_TTL_MS = 5 * 60 * 1000;          // a code is valid for 5 minutes
const OTP_CHALLENGE_TTL_MS = 15 * 60 * 1000; // the whole sign-in attempt
const OTP_MAX_ATTEMPTS = 5;                  // wrong codes before starting over
const OTP_MAX_SENDS = 5;                     // emails per sign-in attempt
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mfaActive() {
  if (process.env.MFA_DISABLED === '1') return false;
  return mailer.brevoConfigured() || mailer.devLogMode();
}

function isEmail(v) {
  return EMAIL_RE.test(String(v || '').trim());
}

function userEmail(u) {
  if (u && isEmail(u.email)) return String(u.email).trim().toLowerCase();
  if (u && isEmail(u.username)) return String(u.username).trim().toLowerCase();
  return '';
}

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}

function hashOtp(challengeId, code) {
  return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

function pruneChallenges(db) {
  const now = Date.now();
  db.mfaChallenges = (db.mfaChallenges || []).filter((c) => new Date(c.expiresAt).getTime() > now);
}

function findChallenge(db, id) {
  pruneChallenges(db);
  const c = db.mfaChallenges.find((x) => x.id === String(id || ''));
  if (!c) throw { status: 400, message: 'This sign-in attempt has expired. Please sign in again.' };
  return c;
}

// Generates a fresh code on the challenge and returns a function that
// emails it — run only after the database write has been committed.
function issueOtp(challenge, user) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  challenge.codeHash = hashOtp(challenge.id, code);
  challenge.codeExpiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  challenge.attempts = 0;
  challenge.sends = (challenge.sends || 0) + 1;
  challenge.lastSentAt = new Date().toISOString();
  const to = challenge.email;
  return () => mailer.sendOtpEmail(to, user.name, code, Math.round(OTP_TTL_MS / 60000));
}

function startSession(db, user) {
  if (!db.sessions) db.sessions = [];
  db.sessions = db.sessions.filter((s) => !auth.isExpired(s));
  const session = auth.newSession(user.id);
  db.sessions.push(session);
  user.lastLoginAt = store.nowIso();
  pushAudit(db, { actor: user.id, action: 'login', portfolioId: null, detail: `${user.name} signed in` });
  return { status: 200, data: { token: session.token, user: stripPassword(user) } };
}

// What each role may see about OTHER accounts. Your own record is always
// returned in full (the Profile page needs it). IT Administrators manage
// accounts, so they see usernames/emails; College Administrators only need
// a name to show who submitted a portfolio; faculty see no one else.
function visibleUsers(db, me) {
  const users = db.users || [];
  if (me.role === 'it') return users.map(stripPassword);
  if (me.role === 'admin') {
    // Last sign-in lets the College Administrator see which faculty are
    // active. Older accounts (before lastLoginAt existed) fall back to the
    // newest "signed in" entry in the activity log.
    const lastLoginFromLog = {};
    (db.auditLogs || []).forEach((l) => {
      if (l.action === 'login' && l.actor && !lastLoginFromLog[l.actor]) lastLoginFromLog[l.actor] = l.at;
    });
    return users.map((u) => (u.id === me.id
      ? stripPassword(u)
      : { id: u.id, name: u.name, role: u.role, lastActiveAt: u.lastLoginAt || lastLoginFromLog[u.id] || null }));
  }
  return [stripPassword(me)];
}

function countIt(db) {
  return (db.users || []).filter((u) => u.role === 'it').length;
}

// The account created from DEFAULT_IT_EMAIL is the system's built-in IT
// Administrator. Other IT Administrators can't delete it, demote it, or
// reset its password — only its owner can change it (from Profile).
function assertNotProtected(target, ctx, what) {
  if (target.isDefaultAdmin && target.id !== ctx.user.id) {
    throw { status: 403, message: `The default IT Administrator account can't be ${what} by another user.` };
  }
}

// Emails a short security notice (account removed, password reset). Never
// fails the request: the change is already saved, and email may be off
// (local dev / tests) — then it's just skipped.
function accountNotice(user, subject, lines) {
  const to = userEmail(user);
  if (!to || (!mailer.brevoConfigured() && !mailer.devLogMode())) return null;
  return () => mailer.sendNoticeEmail(to, user.name, subject, lines)
    .catch((e) => console.error('[mailer] notice not sent:', (e && e.message) || e));
}

function findUserByUsername(db, username) {
  const needle = String(username || '').trim().toLowerCase();
  return (db.users || []).find((u) => String(u.username || '').toLowerCase() === needle);
}

// Resolve the caller's identity from the Authorization header against the
// live db (so the check always reflects current sessions/users).
function resolveAuth(db, req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return null;
  if (!db.sessions) db.sessions = [];
  const session = db.sessions.find((s) => s.token === token);
  if (!session || auth.isExpired(session)) return null;
  const user = (db.users || []).find((u) => u.id === session.userId);
  if (!user) return null;
  return { token, session, user };
}

function requireAuth(db, req) {
  const ctx = resolveAuth(db, req);
  if (!ctx) throw { status: 401, message: 'Your session has expired. Please sign in again.' };
  return ctx;
}

function requireRole(ctx, roles) {
  if (!roles.includes(ctx.user.role)) {
    throw { status: 403, message: 'You do not have permission to perform this action.' };
  }
}

function ownedPortfolio(db, id, ctx) {
  const p = (db.portfolios || []).find((x) => x.id === id);
  if (!p) throw { status: 404, message: 'Portfolio not found.' };
  if (p.facultyId !== ctx.user.id && !['admin', 'it'].includes(ctx.user.role)) {
    throw { status: 403, message: 'You do not have access to this portfolio.' };
  }
  return p;
}

function sanitizeStrList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 100);
}

function docExtOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

// ---------- Phase 1: structured OBTLP field sanitizers ----------
// These mirror the shape produced by seed-ccs101.js from the actual CCS101
// DOCX. Kept generic (not CCS101-specific) so any future department/CHED
// template's course data validates the same way.

function sanitizeSoMap(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 50).map((row) => ({
    soCode: String((row && row.soCode) || '').trim(),
    intensity: String((row && row.intensity) || '').trim(),
    // course-specific SO wording as printed on that course's official OBTLP
    description: String((row && row.description) || '').trim().slice(0, 2000)
  })).filter((row) => row.soCode);
}

function sanitizeTeachingPlanRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'milestone') {
    const label = String(row.label || '').trim();
    return label ? { type: 'milestone', label } : null;
  }
  return {
    type: 'week',
    week: String(row.week || '').trim(),
    topics: sanitizeStrList(row.topics),
    ilo: sanitizeStrList(row.ilo),
    tla: sanitizeStrList(row.tla),
    instructionalMaterials: sanitizeStrList(row.instructionalMaterials),
    assessmentTasks: sanitizeStrList(row.assessmentTasks)
  };
}

function sanitizeTeachingPlan(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).map(sanitizeTeachingPlanRow).filter(Boolean);
}

function sanitizeReferenceGroups(v) {
  const src = v && typeof v === 'object' ? v : {};
  return {
    textbooks: sanitizeStrList(src.textbooks),
    onlineResources: sanitizeStrList(src.onlineResources),
    // Journals / research articles — a separate group in the 2026-2027
    // official PnC OBTLP templates ("Journal/Researches").
    journals: sanitizeStrList(src.journals)
  };
}

// Extra official-format details that differ per course in the 2026-2027
// PnC OBTLP templates (the "Department:" line under the title, the credit
// units cell exactly as printed, the Vision/Mission wording that version of
// the form used, the grading intro line, and the default signatories).
// Kept as one small, strictly-sanitized object so the rest of the data
// model stays unchanged.
function sanitizeSigList(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 10).map((s) => ({
    name: String((s && s.name) || '').trim().slice(0, 200),
    title: String((s && s.title) || '').trim().slice(0, 200)
  })).filter((s) => s.name || s.title);
}

function sanitizeOfficialMeta(v) {
  const src = v && typeof v === 'object' ? v : {};
  const str = (k, max) => String(src[k] || '').trim().slice(0, max || 2000);
  const sig = src.signatories && typeof src.signatories === 'object' ? src.signatories : {};
  return {
    departmentLabel: str('departmentLabel', 200),
    creditUnits: str('creditUnits', 100),
    vision: str('vision'),
    mission: str('mission'),
    peoIntro: str('peoIntro', 500),
    peo: sanitizeStrList(src.peo),
    division: str('division', 200),
    gradingIntro: str('gradingIntro', 1000),
    signatories: {
      preparedBy: sanitizeSigList(sig.preparedBy),
      reviewedBy: sanitizeSigList(sig.reviewedBy),
      concurredBy: sanitizeSigList(sig.concurredBy),
      approvedBy: sanitizeSigList(sig.approvedBy)
    }
  };
}

function sanitizeGradingComponent(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  if (!name) return null;
  const items = Array.isArray(c.items) ? c.items.slice(0, 50).map((it) => ({
    item: String((it && it.item) || '').trim(),
    source: String((it && it.source) || '').trim(),
    pct: Number.isFinite(Number(it && it.pct)) ? Number(it.pct) : 0
  })).filter((it) => it.item) : [];
  return {
    name,
    weightPct: Number.isFinite(Number(c.weightPct)) ? Number(c.weightPct) : 0,
    weightNote: String(c.weightNote || '').trim(),
    items
  };
}

function sanitizeGrading(v) {
  const src = v && typeof v === 'object' ? v : {};
  const components = Array.isArray(src.components) ? src.components.slice(0, 10).map(sanitizeGradingComponent).filter(Boolean) : [];
  return { components };
}

function sanitizeSignatory(s) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name || '').trim();
  if (!name) return null;
  return { name, date: String(s.date || '').trim() };
}

function sanitizeSignatories(v) {
  const src = v && typeof v === 'object' ? v : {};
  const single = (s) => sanitizeSignatory(s) || null;
  const multi = (arr) => (Array.isArray(arr) ? arr.slice(0, 10).map(sanitizeSignatory).filter(Boolean) : []);
  return {
    preparedBy: multi(src.preparedBy),
    reviewedBy: single(src.reviewedBy),
    concurredBy: single(src.concurredBy),
    approvedBy: multi(src.approvedBy)
  };
}

// Phase 3: light relational validation so the Department/Program/Template
// selectors can't be pointed at nonsense — friendly 400s instead of silently
// accepting a broken link (which would just fail to resolve a template
// later, invisibly). Empty strings are always allowed (means "not set").
function assertDeptProgramLink(db, departmentId, programId) {
  const deptId = String(departmentId || '').trim();
  const progId = String(programId || '').trim();
  if (deptId && !(db.departments || []).some((d) => d.id === deptId)) {
    throw { status: 400, message: 'Selected Department was not found. Please choose a Department again.' };
  }
  if (progId) {
    const program = (db.programs || []).find((p) => p.id === progId);
    if (!program) {
      throw { status: 400, message: 'Selected Program was not found. Please choose a Program again.' };
    }
    if (deptId && program.departmentId !== deptId) {
      throw { status: 400, message: 'The selected Program does not belong to the selected Department.' };
    }
  }
}

function blankStructuredFields() {
  return {
    departmentId: '',
    programId: '',
    prerequisite: '',
    soMap: [],
    teachingPlan: [],
    referenceGroups: { textbooks: [], onlineResources: [], journals: [] },
    grading: { components: [] },
    courseRequirements: [],
    classPoliciesOverride: '',
    effectivityText: '',
    officialMeta: sanitizeOfficialMeta({})
  };
}

// Reusable Course Code / Course Title / Department / Academic Year lists for
// the portfolio wizard's searchable selectors. Built from whatever faculty
// have explicitly added (db.catalog) merged with distinct values already
// used on saved portfolios, so the list stays useful even before anyone
// explicitly "creates" an entry.
function buildCatalog(db) {
  const catalog = db.catalog || { courses: [], departments: [], academicYears: [] };

  const courseMap = new Map();
  (catalog.courses || []).forEach((c) => {
    const code = String(c.code || '').trim();
    const title = String(c.title || '').trim();
    if (!code && !title) return;
    courseMap.set(`${code.toLowerCase()}|${title.toLowerCase()}`, { code, title });
  });
  (db.portfolios || []).forEach((p) => {
    const code = String(p.courseCode || '').trim();
    const title = String(p.courseTitle || '').trim();
    if (!code && !title) return;
    const key = `${code.toLowerCase()}|${title.toLowerCase()}`;
    if (!courseMap.has(key)) courseMap.set(key, { code, title });
  });

  const departments = new Set((catalog.departments || []).map((d) => String(d || '').trim()).filter(Boolean));
  (db.portfolios || []).forEach((p) => {
    const dept = String(p.facultyDepartment || '').trim();
    if (dept) departments.add(dept);
  });

  const academicYears = new Set((catalog.academicYears || []).map((y) => String(y || '').trim()).filter(Boolean));
  (db.portfolios || []).forEach((p) => {
    const year = String(p.academicYear || '').trim();
    if (year) academicYears.add(year);
  });

  return {
    courses: Array.from(courseMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
    departments: Array.from(departments).sort((a, b) => a.localeCompare(b)),
    academicYears: Array.from(academicYears).sort((a, b) => b.localeCompare(a))
  };
}

// ---------- route table ----------
// Each entry: { auth: bool, roles: [optional array], handler(db, ctx, query, body, params) }

const routes = {
  // ---- public / auth ----
  'GET /api/setup-status': {
    auth: false,
    handler: (db) => ({ status: 200, data: { hasUsers: (db.users || []).length > 0 } })
  },

  'POST /api/setup': {
    auth: false,
    handler: (db, ctx, query, body) => {
      if ((db.users || []).length > 0) {
        throw { status: 403, message: 'Setup has already been completed. Please sign in, or contact your IT administrator.' };
      }
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const role = String(body.role || 'it').toLowerCase();
      if (!name || !username || !password) {
        throw { status: 400, message: 'Name, username, and password are required.' };
      }
      if (!['admin', 'it'].includes(role)) {
        throw { status: 400, message: 'The first account must be an Administrator or IT Administrator.' };
      }
      if (password.length < 6) {
        throw { status: 400, message: 'Password must be at least 6 characters.' };
      }
      const user = {
        id: store.nextId('u'),
        name,
        username,
        role,
        createdVia: 'setup',
        passwordHash: auth.hashPassword(password)
      };
      if (isEmail(username)) user.email = username.toLowerCase();
      db.users = [user];
      pushAudit(db, { actor: user.id, action: 'user-create', portfolioId: null, detail: `Created initial ${user.role} account ${user.username}` });
      const session = auth.newSession(user.id);
      if (!db.sessions) db.sessions = [];
      db.sessions.push(session);
      return { status: 201, data: { token: session.token, user: stripPassword(user) } };
    }
  },

  'POST /api/register': {
    auth: false,
    handler: (db, ctx, query, body) => {
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      if (!name || !username || !password || !confirmPassword) {
        throw { status: 400, message: 'Please fill in all required fields.' };
      }
      if (password !== confirmPassword) {
        throw { status: 400, message: 'Password and confirm password do not match.' };
      }
      if (password.length < 6) {
        throw { status: 400, message: 'Password must be at least 6 characters.' };
      }
      // Sign-in codes are emailed, so every new account needs a real email.
      if (!isEmail(username)) {
        throw { status: 400, message: 'Please use your email address (e.g. your Gmail) — sign-in codes are sent there.' };
      }
      if (findUserByUsername(db, username) || (db.users || []).some((u) => userEmail(u) === username.toLowerCase())) {
        throw { status: 409, message: 'An account with that email already exists.' };
      }
      // Public sign-up is for faculty only. College Administrator and IT
      // Administrator accounts are created by an IT Administrator from the
      // User Accounts page (and the first IT Administrator comes from the
      // DEFAULT_IT_* settings — see ensureDefaultItAdmin). Any role sent
      // here is ignored, so nobody can give themselves admin rights.
      const user = {
        id: store.nextId('u'),
        name,
        username,
        email: username.toLowerCase(),
        role: 'faculty',
        createdVia: 'register',
        passwordHash: auth.hashPassword(password)
      };
      if (!db.users) db.users = [];
      db.users.push(user);
      pushAudit(db, { actor: user.id, action: 'user-create', portfolioId: null, detail: `Registered new faculty account ${user.username}` });
      const session = auth.newSession(user.id);
      if (!db.sessions) db.sessions = [];
      db.sessions.push(session);
      return { status: 201, data: { token: session.token, user: stripPassword(user) } };
    }
  },

  'POST /api/login': {
    auth: false,
    handler: (db, ctx, query, body) => {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const selectedRole = body.role ? String(body.role).toLowerCase() : null;
      if (!username || !password) {
        throw { status: 400, message: 'Username and password are required.' };
      }
      if (selectedRole && !isRole(selectedRole)) {
        throw { status: 400, message: 'Please choose a valid role.' };
      }
      const user = findUserByUsername(db, username);
      if (!user) {
        throw { status: 401, message: 'Incorrect username or password.' };
      }
      if (!user.passwordHash || !auth.verifyPassword(password, user.passwordHash)) {
        throw { status: 401, message: 'Incorrect username or password.' };
      }
      // The selected role is a real credential check, not a client-trusted
      // value: a correct password with the wrong role selection is rejected
      // with the same generic message used for a wrong password, so the
      // login form can't be used to probe which role an account holds.
      if (selectedRole && user.role !== selectedRole) {
        throw { status: 401, message: 'Incorrect username or password.' };
      }
      if (!mfaActive()) return startSession(db, user);

      // A browser this user marked "Trust this device" skips the emailed
      // code (the password above was still checked).
      const trusted = findTrustedDevice(user, body.deviceToken);
      if (trusted) {
        trusted.lastUsedAt = store.nowIso();
        user.trustedDevices = activeTrustedDevices(user);
        const res = startSession(db, user);
        res.data.trustedDevice = true;
        return res;
      }

      // Second factor: email a one-time code instead of signing in now.
      pruneChallenges(db);
      db.mfaChallenges = db.mfaChallenges.filter((c) => c.userId !== user.id);
      const challenge = {
        id: auth.makeToken(),
        userId: user.id,
        email: userEmail(user),
        expiresAt: new Date(Date.now() + OTP_CHALLENGE_TTL_MS).toISOString(),
        sends: 0
      };
      db.mfaChallenges.push(challenge);
      if (!challenge.email) {
        // Older accounts whose username isn't an email: ask for one first.
        return { status: 200, data: { emailRequired: true, challengeId: challenge.id } };
      }
      const send = issueOtp(challenge, user);
      return {
        status: 200,
        data: { mfaRequired: true, challengeId: challenge.id, maskedEmail: maskEmail(challenge.email) },
        afterCommit: send
      };
    }
  },

  // Accounts without an email on file give one during sign-in; it is only
  // saved to the account after a code sent to it is entered correctly.
  'POST /api/login/email': {
    auth: false,
    handler: (db, ctx, query, body) => {
      const challenge = findChallenge(db, body.challengeId);
      const email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) throw { status: 400, message: 'Please enter a valid email address.' };
      const user = (db.users || []).find((u) => u.id === challenge.userId);
      if (!user) throw { status: 400, message: 'This sign-in attempt has expired. Please sign in again.' };
      if ((db.users || []).some((u) => u.id !== user.id && userEmail(u) === email)) {
        throw { status: 409, message: 'That email is already used by another account.' };
      }
      if ((challenge.sends || 0) >= OTP_MAX_SENDS) {
        throw { status: 429, message: 'Too many codes sent. Please sign in again later.' };
      }
      challenge.email = email;
      challenge.pendingEmail = true;
      const send = issueOtp(challenge, user);
      return {
        status: 200,
        data: { mfaRequired: true, challengeId: challenge.id, maskedEmail: maskEmail(email) },
        afterCommit: send
      };
    }
  },

  'POST /api/login/verify': {
    auth: false,
    handler: (db, ctx, query, body, params, req) => {
      const challenge = findChallenge(db, body.challengeId);
      const code = String(body.code || '').replace(/\D/g, '');
      if (!challenge.codeHash) throw { status: 400, message: 'Please request a verification code first.' };
      if (new Date(challenge.codeExpiresAt).getTime() < Date.now()) {
        throw { status: 400, message: 'This code has expired. Tap "Resend code" to get a new one.' };
      }
      const ok = code.length === 6 && crypto.timingSafeEqual(
        Buffer.from(hashOtp(challenge.id, code), 'hex'),
        Buffer.from(challenge.codeHash, 'hex')
      );
      if (!ok) {
        challenge.attempts = (challenge.attempts || 0) + 1;
        if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
          db.mfaChallenges = db.mfaChallenges.filter((c) => c.id !== challenge.id);
          // Still a normal 400 (not a thrown error) so the attempt count and
          // removal are saved.
          return { status: 400, data: { error: 'Too many incorrect codes. Please sign in again.', restart: true } };
        }
        const left = OTP_MAX_ATTEMPTS - challenge.attempts;
        return { status: 400, data: { error: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` } };
      }
      const user = (db.users || []).find((u) => u.id === challenge.userId);
      db.mfaChallenges = db.mfaChallenges.filter((c) => c.id !== challenge.id);
      if (!user) throw { status: 400, message: 'This sign-in attempt has expired. Please sign in again.' };
      if (challenge.pendingEmail) user.email = challenge.email;
      const deviceToken = body.trustDevice === true ? trustDevice(user, req) : null;
      const res = startSession(db, user);
      if (deviceToken) {
        res.data.deviceToken = deviceToken;
        res.data.trustedDays = Math.round(TRUST_TTL_MS / 86400000);
        pushAudit(db, { actor: user.id, action: 'login', portfolioId: null, detail: `${user.name} trusted this device (${deviceLabel(req)}) for 30 days` });
      }
      return res;
    }
  },

  'POST /api/login/resend': {
    auth: false,
    handler: (db, ctx, query, body) => {
      const challenge = findChallenge(db, body.challengeId);
      if (!challenge.email) throw { status: 400, message: 'Please enter your email address first.' };
      const user = (db.users || []).find((u) => u.id === challenge.userId);
      if (!user) throw { status: 400, message: 'This sign-in attempt has expired. Please sign in again.' };
      if ((challenge.sends || 0) >= OTP_MAX_SENDS) {
        throw { status: 429, message: 'Too many codes sent. Please sign in again later.' };
      }
      const wait = OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(challenge.lastSentAt || 0).getTime());
      if (wait > 0) throw { status: 429, message: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting a new code.` };
      const send = issueOtp(challenge, user);
      return { status: 200, data: { ok: true, maskedEmail: maskEmail(challenge.email) }, afterCommit: send };
    }
  },

  'POST /api/logout': {
    auth: true,
    handler: (db, ctx) => {
      db.sessions = (db.sessions || []).filter((s) => s.token !== ctx.token);
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- self-service profile (any signed-in user, own account only) ----
  'PUT /api/me': {
    auth: true,
    handler: (db, ctx, query, body) => {
      const name = String(body.name || '').trim();
      if (!name) throw { status: 400, message: 'Name is required.' };
      ctx.user.name = name;
      pushAudit(db, { actor: ctx.user.id, action: 'user-update', portfolioId: null, detail: `${ctx.user.username} updated their profile` });
      return { status: 200, data: stripPassword(ctx.user) };
    }
  },

  'POST /api/me/password': {
    auth: true,
    handler: (db, ctx, query, body) => {
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!currentPassword || !newPassword) {
        throw { status: 400, message: 'Current and new password are required.' };
      }
      if (!auth.verifyPassword(currentPassword, ctx.user.passwordHash)) {
        // 403, not 401: the browser treats 401 as "session expired" and signs out.
        throw { status: 403, message: 'Your current password is incorrect.' };
      }
      if (newPassword.length < 6) {
        throw { status: 400, message: 'New password must be at least 6 characters.' };
      }
      ctx.user.passwordHash = auth.hashPassword(newPassword);
      forgetTrustedDevices(ctx.user);
      // Keep the session that just made this change alive; sign the account
      // out everywhere else since the old password is no longer valid.
      db.sessions = (db.sessions || []).filter((s) => s.token === ctx.token || s.userId !== ctx.user.id);
      pushAudit(db, { actor: ctx.user.id, action: 'password-change', portfolioId: null, detail: `${ctx.user.username} changed their own password` });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- trusted devices (own account) ----
  'GET /api/me/trusted-devices': {
    auth: true,
    handler: (db, ctx) => ({
      status: 200,
      data: activeTrustedDevices(ctx.user).map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt }))
    })
  },

  'DELETE /api/me/trusted-devices': {
    auth: true,
    handler: (db, ctx) => {
      const n = activeTrustedDevices(ctx.user).length;
      forgetTrustedDevices(ctx.user);
      pushAudit(db, { actor: ctx.user.id, action: 'user-update', portfolioId: null, detail: `${ctx.user.username} forgot ${n} trusted device${n === 1 ? '' : 's'}` });
      return { status: 200, data: { ok: true, removed: n } };
    }
  },

  // ---- state ----
  'GET /api/state': {
    auth: true,
    handler: (db, ctx) => {
      const isStaff = ['admin', 'it'].includes(ctx.user.role);
      const portfolios = isStaff ? (db.portfolios || []) : (db.portfolios || []).filter((p) => p.facultyId === ctx.user.id);
      const notifications = (db.notifications || []).filter(
        (n) => n.userId === ctx.user.id || n.role === ctx.user.role
      );
      return {
        status: 200,
        data: {
          users: visibleUsers(db, ctx.user),
          portfolios,
          allPortfolios: isStaff ? (db.portfolios || []) : [],
          notifications,
          auditLogs: isStaff ? (db.auditLogs || []).slice(0, 50) : [],
          settings: db.settings || {}
        }
      };
    }
  },

  // ---- catalog (reusable course / department / academic year picks) ----
  'GET /api/catalog': {
    auth: true,
    handler: (db) => ({ status: 200, data: buildCatalog(db) })
  },

  'POST /api/catalog': {
    auth: true,
    roles: ['faculty'],
    handler: (db, ctx, query, body) => {
      if (!db.catalog) db.catalog = { courses: [], departments: [], academicYears: [] };
      const type = String(body.type || '');
      if (type === 'course') {
        const code = String(body.code || '').trim();
        const title = String(body.title || '').trim();
        if (!code || !title) throw { status: 400, message: 'Course code and title are required.' };
        const exists = db.catalog.courses.some(
          (c) => String(c.code || '').toLowerCase() === code.toLowerCase() && String(c.title || '').toLowerCase() === title.toLowerCase()
        );
        if (!exists) db.catalog.courses.push({ code, title });
      } else if (type === 'department') {
        const name = String(body.name || '').trim();
        if (!name) throw { status: 400, message: 'Department name is required.' };
        if (!db.catalog.departments.some((d) => String(d || '').toLowerCase() === name.toLowerCase())) {
          db.catalog.departments.push(name);
        }
      } else if (type === 'academicYear') {
        const year = String(body.year || '').trim();
        if (!year) throw { status: 400, message: 'Academic year is required.' };
        if (!db.catalog.academicYears.some((y) => String(y || '').toLowerCase() === year.toLowerCase())) {
          db.catalog.academicYears.push(year);
        }
      } else {
        throw { status: 400, message: 'Unknown catalog entry type.' };
      }
      return { status: 200, data: buildCatalog(db) };
    }
  },

  // ---- departments (Phase 1: Department -> Program -> Course -> Template) ----
  'GET /api/departments': {
    auth: true,
    handler: (db) => ({ status: 200, data: (db.departments || []) })
  },

  'POST /api/departments': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      const code = String(body.code || '').trim();
      const name = String(body.name || '').trim();
      if (!code || !name) throw { status: 400, message: 'Department code and name are required.' };
      if (!db.departments) db.departments = [];
      if (db.departments.some((d) => d.code.toLowerCase() === code.toLowerCase())) {
        throw { status: 409, message: `A department with code ${code} already exists.` };
      }
      const dept = { id: store.nextId('dept'), code, name, createdAt: store.nowIso() };
      db.departments.push(dept);
      pushAudit(db, { actor: ctx.user.id, action: 'department-create', portfolioId: null, detail: `Created department ${code} — ${name}` });
      return { status: 201, data: dept };
    }
  },

  'PUT /api/departments/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const dept = (db.departments || []).find((d) => d.id === params.id);
      if (!dept) throw { status: 404, message: 'Department not found.' };
      if (body.code !== undefined) dept.code = String(body.code).trim();
      if (body.name !== undefined) dept.name = String(body.name).trim();
      pushAudit(db, { actor: ctx.user.id, action: 'department-update', portfolioId: null, detail: `Updated department ${dept.code}` });
      return { status: 200, data: dept };
    }
  },

  'DELETE /api/departments/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const dept = (db.departments || []).find((d) => d.id === params.id);
      if (!dept) throw { status: 404, message: 'Department not found.' };
      if ((db.programs || []).some((p) => p.departmentId === dept.id)) {
        throw { status: 409, message: 'This department still has programs under it. Remove those first.' };
      }
      db.departments = db.departments.filter((d) => d.id !== dept.id);
      pushAudit(db, { actor: ctx.user.id, action: 'department-delete', portfolioId: null, detail: `Deleted department ${dept.code}` });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- programs (belong to a department; carry PEO + Student Outcomes) ----
  'GET /api/programs': {
    auth: true,
    handler: (db, ctx, query) => {
      const deptId = query.get ? query.get('departmentId') : null;
      let programs = db.programs || [];
      if (deptId) programs = programs.filter((p) => p.departmentId === deptId);
      return { status: 200, data: programs };
    }
  },

  'POST /api/programs': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      const departmentId = String(body.departmentId || '').trim();
      const code = String(body.code || '').trim();
      const name = String(body.name || '').trim();
      if (!departmentId || !code || !name) throw { status: 400, message: 'Department, program code, and program name are required.' };
      if (!(db.departments || []).some((d) => d.id === departmentId)) throw { status: 400, message: 'Unknown department.' };
      if (!db.programs) db.programs = [];
      if (db.programs.some((p) => p.code.toLowerCase() === code.toLowerCase() && p.departmentId === departmentId)) {
        throw { status: 409, message: `A program with code ${code} already exists in this department.` };
      }
      const program = {
        id: store.nextId('prog'),
        departmentId,
        code,
        name,
        peoIntro: String(body.peoIntro || ''),
        peo: sanitizeStrList(body.peo),
        studentOutcomes: Array.isArray(body.studentOutcomes)
          ? body.studentOutcomes.slice(0, 50).map((s) => ({ code: String((s && s.code) || '').trim(), description: String((s && s.description) || '').trim() })).filter((s) => s.code)
          : [],
        createdAt: store.nowIso()
      };
      db.programs.push(program);
      pushAudit(db, { actor: ctx.user.id, action: 'program-create', portfolioId: null, detail: `Created program ${code} — ${name}` });
      return { status: 201, data: program };
    }
  },

  'PUT /api/programs/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const program = (db.programs || []).find((p) => p.id === params.id);
      if (!program) throw { status: 404, message: 'Program not found.' };
      if (body.departmentId !== undefined) program.departmentId = String(body.departmentId).trim();
      if (body.code !== undefined) program.code = String(body.code).trim();
      if (body.name !== undefined) program.name = String(body.name).trim();
      if (body.peoIntro !== undefined) program.peoIntro = String(body.peoIntro);
      if (body.peo !== undefined) program.peo = sanitizeStrList(body.peo);
      if (body.studentOutcomes !== undefined) {
        program.studentOutcomes = Array.isArray(body.studentOutcomes)
          ? body.studentOutcomes.slice(0, 50).map((s) => ({ code: String((s && s.code) || '').trim(), description: String((s && s.description) || '').trim() })).filter((s) => s.code)
          : [];
      }
      pushAudit(db, { actor: ctx.user.id, action: 'program-update', portfolioId: null, detail: `Updated program ${program.code}` });
      return { status: 200, data: program };
    }
  },

  'DELETE /api/programs/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const program = (db.programs || []).find((p) => p.id === params.id);
      if (!program) throw { status: 404, message: 'Program not found.' };
      if ((db.courseTemplates || []).some((t) => t.programId === program.id)) {
        throw { status: 409, message: 'This program still has course templates under it. Remove those first.' };
      }
      db.programs = db.programs.filter((p) => p.id !== program.id);
      pushAudit(db, { actor: ctx.user.id, action: 'program-delete', portfolioId: null, detail: `Deleted program ${program.code}` });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- OBTLP templates (data-driven blueprint; one row per department/
  // program template version — the CCS101 template seeded from the actual
  // DOCX is the first of these, not a special case in the code) ----
  'GET /api/obtlp-templates': {
    auth: true,
    handler: (db, ctx) => {
      const isStaff = ['admin', 'it'].includes(ctx.user.role);
      const templates = db.obtlpTemplates || [];
      return { status: 200, data: isStaff ? templates : templates.filter((t) => t.active) };
    }
  },

  'POST /api/obtlp-templates': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      const code = String(body.code || '').trim();
      const name = String(body.name || '').trim();
      if (!code || !name) throw { status: 400, message: 'Template code and name are required.' };
      if (!Array.isArray(body.sections) || !body.sections.length) {
        throw { status: 400, message: 'A template needs at least one section.' };
      }
      if (!db.obtlpTemplates) db.obtlpTemplates = [];
      if (db.obtlpTemplates.some((t) => t.code.toLowerCase() === code.toLowerCase())) {
        throw { status: 409, message: `A template with code ${code} already exists.` };
      }
      const template = {
        id: store.nextId('tpl'),
        code,
        name,
        departmentId: String(body.departmentId || ''),
        programId: String(body.programId || ''),
        version: String(body.version || '1'),
        formCode: String(body.formCode || ''),
        effectivityText: String(body.effectivityText || ''),
        active: body.active !== undefined ? !!body.active : true,
        sections: body.sections,
        createdAt: store.nowIso(),
        updatedAt: store.nowIso()
      };
      db.obtlpTemplates.push(template);
      pushAudit(db, { actor: ctx.user.id, action: 'obtlp-template-create', portfolioId: null, detail: `Created OBTLP template ${code}` });
      return { status: 201, data: template };
    }
  },

  'PUT /api/obtlp-templates/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const tpl = (db.obtlpTemplates || []).find((t) => t.id === params.id);
      if (!tpl) throw { status: 404, message: 'OBTLP template not found.' };
      if (body.name !== undefined) tpl.name = String(body.name).trim();
      if (body.departmentId !== undefined) tpl.departmentId = String(body.departmentId);
      if (body.programId !== undefined) tpl.programId = String(body.programId);
      if (body.version !== undefined) tpl.version = String(body.version);
      if (body.formCode !== undefined) tpl.formCode = String(body.formCode);
      if (body.effectivityText !== undefined) tpl.effectivityText = String(body.effectivityText);
      if (body.active !== undefined) tpl.active = !!body.active;
      if (body.sections !== undefined) {
        if (!Array.isArray(body.sections) || !body.sections.length) {
          throw { status: 400, message: 'A template needs at least one section.' };
        }
        tpl.sections = body.sections;
      }
      tpl.updatedAt = store.nowIso();
      pushAudit(db, { actor: ctx.user.id, action: 'obtlp-template-update', portfolioId: null, detail: `Updated OBTLP template ${tpl.code}` });
      return { status: 200, data: tpl };
    }
  },

  'DELETE /api/obtlp-templates/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const tpl = (db.obtlpTemplates || []).find((t) => t.id === params.id);
      if (!tpl) throw { status: 404, message: 'OBTLP template not found.' };
      if ((db.courseTemplates || []).some((t) => t.obtlpTemplateId === tpl.id)) {
        throw { status: 409, message: 'This template is still linked to course templates. Unlink those first.' };
      }
      db.obtlpTemplates = db.obtlpTemplates.filter((t) => t.id !== tpl.id);
      pushAudit(db, { actor: ctx.user.id, action: 'obtlp-template-delete', portfolioId: null, detail: `Deleted OBTLP template ${tpl.code}` });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- org profile (Vision/Mission/Core Values/Graduate Attributes, SO
  // intensity legend, standard attendance rule, standard class policies —
  // shared boilerplate reused by every OBTLP template) ----
  'GET /api/org-profile': {
    auth: true,
    handler: (db) => ({ status: 200, data: db.orgProfile || {} })
  },

  'PUT /api/org-profile': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      db.orgProfile = Object.assign({}, db.orgProfile, body, { updatedAt: store.nowIso() });
      pushAudit(db, { actor: ctx.user.id, action: 'org-profile-update', portfolioId: null, detail: 'Updated organization profile' });
      return { status: 200, data: db.orgProfile };
    }
  },

  // ---- course templates (official per-course content, managed by staff) ----
  // Selecting a Course Code in the portfolio wizard looks up a template here
  // to auto-populate the text sections. Faculty get read-only access so the
  // wizard can look one up; only staff (admin/it) can create or change one.
  'GET /api/course-templates': {
    auth: true,
    handler: (db) => ({ status: 200, data: (db.courseTemplates || []) })
  },

  'POST /api/course-templates': {
    auth: true,
    roles: ['admin', 'it'],
    handler: (db, ctx, query, body) => {
      const courseCode = String(body.courseCode || '').trim();
      if (!courseCode) throw { status: 400, message: 'Course code is required.' };
      if (!db.courseTemplates) db.courseTemplates = [];
      // The same course code can exist in more than one program with
      // different content (e.g. CCS102 in both BSCS and BSIT), so a
      // duplicate is the same code within the SAME program only.
      const newProgramId = String(body.programId || '');
      const dup = db.courseTemplates.some((t) => t.courseCode.toLowerCase() === courseCode.toLowerCase() && String(t.programId || '') === newProgramId);
      if (dup) throw { status: 409, message: `A template for ${courseCode} already exists for this program. Edit it instead of creating a duplicate.` };
      assertDeptProgramLink(db, body.departmentId, body.programId);
      if (body.obtlpTemplateId && !(db.obtlpTemplates || []).some((t) => t.id === body.obtlpTemplateId)) {
        throw { status: 400, message: 'Selected OBTLP Template was not found. Please choose again.' };
      }
      const template = Object.assign(blankStructuredFields(), {
        id: store.nextId('tpl'),
        courseCode,
        courseTitle: String(body.courseTitle || '').trim(),
        description: String(body.description || ''),
        objectives: sanitizeStrList(body.objectives),
        outcomes: sanitizeStrList(body.outcomes),
        syllabus: String(body.syllabus || ''),
        teachingMaterials: sanitizeStrList(body.teachingMaterials),
        references: sanitizeStrList(body.references),
        // Phase 1 structured fields (all optional — a course template
        // without an OBTLP template still works exactly as before).
        departmentId: String(body.departmentId || ''),
        programId: String(body.programId || ''),
        obtlpTemplateId: String(body.obtlpTemplateId || ''),
        prerequisite: String(body.prerequisite || ''),
        soMap: sanitizeSoMap(body.soMap),
        teachingPlan: sanitizeTeachingPlan(body.teachingPlan),
        referenceGroups: sanitizeReferenceGroups(body.referenceGroups),
        grading: sanitizeGrading(body.grading),
        courseRequirements: sanitizeStrList(body.courseRequirements),
        classPoliciesOverride: String(body.classPoliciesOverride || ''),
        effectivityText: String(body.effectivityText || ''),
        officialMeta: sanitizeOfficialMeta(body.officialMeta),
        updatedBy: ctx.user.id,
        createdAt: store.nowIso(),
        updatedAt: store.nowIso()
      });
      db.courseTemplates.push(template);
      pushAudit(db, { actor: ctx.user.id, action: 'template-create', portfolioId: null, detail: `Created course template for ${courseCode}` });
      return { status: 201, data: template };
    }
  },

  'PUT /api/course-templates/:id': {
    auth: true,
    roles: ['admin', 'it'],
    handler: (db, ctx, query, body, params) => {
      const tpl = (db.courseTemplates || []).find((t) => t.id === params.id);
      if (!tpl) throw { status: 404, message: 'Course template not found.' };
      if (body.courseCode !== undefined) tpl.courseCode = String(body.courseCode || '').trim();
      if (body.courseTitle !== undefined) tpl.courseTitle = String(body.courseTitle || '').trim();
      if (body.description !== undefined) tpl.description = String(body.description || '');
      if (body.syllabus !== undefined) tpl.syllabus = String(body.syllabus || '');
      if (body.objectives !== undefined) tpl.objectives = sanitizeStrList(body.objectives);
      if (body.outcomes !== undefined) tpl.outcomes = sanitizeStrList(body.outcomes);
      if (body.teachingMaterials !== undefined) tpl.teachingMaterials = sanitizeStrList(body.teachingMaterials);
      if (body.references !== undefined) tpl.references = sanitizeStrList(body.references);
      if (body.departmentId !== undefined || body.programId !== undefined) {
        assertDeptProgramLink(db, body.departmentId !== undefined ? body.departmentId : tpl.departmentId, body.programId !== undefined ? body.programId : tpl.programId);
      }
      if (body.obtlpTemplateId !== undefined && body.obtlpTemplateId && !(db.obtlpTemplates || []).some((t) => t.id === body.obtlpTemplateId)) {
        throw { status: 400, message: 'Selected OBTLP Template was not found. Please choose again.' };
      }
      if (body.departmentId !== undefined) tpl.departmentId = String(body.departmentId || '');
      if (body.programId !== undefined) tpl.programId = String(body.programId || '');
      if (body.obtlpTemplateId !== undefined) tpl.obtlpTemplateId = String(body.obtlpTemplateId || '');
      if (body.prerequisite !== undefined) tpl.prerequisite = String(body.prerequisite || '');
      if (body.soMap !== undefined) tpl.soMap = sanitizeSoMap(body.soMap);
      if (body.teachingPlan !== undefined) tpl.teachingPlan = sanitizeTeachingPlan(body.teachingPlan);
      if (body.referenceGroups !== undefined) tpl.referenceGroups = sanitizeReferenceGroups(body.referenceGroups);
      if (body.grading !== undefined) tpl.grading = sanitizeGrading(body.grading);
      if (body.courseRequirements !== undefined) tpl.courseRequirements = sanitizeStrList(body.courseRequirements);
      if (body.classPoliciesOverride !== undefined) tpl.classPoliciesOverride = String(body.classPoliciesOverride || '');
      if (body.effectivityText !== undefined) tpl.effectivityText = String(body.effectivityText || '');
      if (body.officialMeta !== undefined) tpl.officialMeta = sanitizeOfficialMeta(body.officialMeta);
      tpl.updatedBy = ctx.user.id;
      tpl.updatedAt = store.nowIso();
      pushAudit(db, { actor: ctx.user.id, action: 'template-update', portfolioId: null, detail: `Updated course template for ${tpl.courseCode}` });
      return { status: 200, data: tpl };
    }
  },

  'DELETE /api/course-templates/:id': {
    auth: true,
    roles: ['admin', 'it'],
    handler: (db, ctx, query, body, params) => {
      const tpl = (db.courseTemplates || []).find((t) => t.id === params.id);
      if (!tpl) throw { status: 404, message: 'Course template not found.' };
      db.courseTemplates = (db.courseTemplates || []).filter((t) => t.id !== params.id);
      pushAudit(db, { actor: ctx.user.id, action: 'template-delete', portfolioId: null, detail: `Deleted course template for ${tpl.courseCode}` });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- portfolios ----
  'POST /api/portfolios': {
    auth: true,
    roles: ['faculty'],
    handler: (db, ctx) => {
      const id = store.nextId('p');
      const portfolio = Object.assign(blankStructuredFields(), {
        id,
        facultyId: ctx.user.id,
        courseCode: '',
        courseTitle: '',
        semester: '1st Semester',
        academicYear: '',
        description: '',
        facultyDepartment: '',
        facultyUnits: '',
        facultySchedule: '',
        objectives: [],
        outcomes: [],
        syllabus: '',
        teachingMaterials: [],
        references: [],
        documents: [],
        documentCount: 0,
        notes: '',
        // Phase 1: which OBTLP template (if any) this portfolio was
        // generated against, captured at creation/course-selection time so
        // later edits to the template don't retroactively change a
        // portfolio that's already in progress or submitted.
        templateId: '',
        signatories: { preparedBy: [], reviewedBy: null, concurredBy: null, approvedBy: [] },
        updatedAt: store.nowIso(),
        createdAt: store.nowIso(),
        status: 'Draft',
        review: { notes: '', requestedRevisionAt: null, approvedAt: null }
      });
      if (!db.portfolios) db.portfolios = [];
      db.portfolios.push(portfolio);
      pushAudit(db, { actor: ctx.user.id, action: 'create', portfolioId: id, detail: 'Created a new draft portfolio' });
      return { status: 201, data: portfolio };
    }
  },

  'PUT /api/portfolios/:id': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id) {
        throw { status: 403, message: 'Only the owning faculty member can edit this portfolio.' };
      }
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This portfolio is ${p.status.toLowerCase()} and can no longer be edited.` };
      }
      if (body.departmentId !== undefined || body.programId !== undefined) {
        assertDeptProgramLink(db, body.departmentId !== undefined ? body.departmentId : p.departmentId, body.programId !== undefined ? body.programId : p.programId);
      }
      const stringFields = [
        'courseCode', 'courseTitle', 'semester', 'academicYear', 'description',
        'facultyDepartment', 'facultyUnits', 'facultySchedule', 'syllabus', 'notes',
        'departmentId', 'programId', 'templateId', 'prerequisite', 'classPoliciesOverride', 'effectivityText'
      ];
      stringFields.forEach((k) => {
        if (body[k] !== undefined) p[k] = String(body[k]);
      });
      const listFields = ['objectives', 'outcomes', 'teachingMaterials', 'references', 'courseRequirements'];
      listFields.forEach((k) => {
        if (body[k] !== undefined) p[k] = sanitizeStrList(body[k]);
      });
      if (body.soMap !== undefined) p.soMap = sanitizeSoMap(body.soMap);
      if (body.teachingPlan !== undefined) p.teachingPlan = sanitizeTeachingPlan(body.teachingPlan);
      if (body.referenceGroups !== undefined) p.referenceGroups = sanitizeReferenceGroups(body.referenceGroups);
      if (body.grading !== undefined) p.grading = sanitizeGrading(body.grading);
      if (body.signatories !== undefined) p.signatories = sanitizeSignatories(body.signatories);
      if (body.officialMeta !== undefined) p.officialMeta = sanitizeOfficialMeta(body.officialMeta);
      p.updatedAt = store.nowIso();
      pushAudit(db, { actor: p.facultyId, action: 'edit', portfolioId: p.id, detail: `Edited ${p.courseCode || 'portfolio'}` });
      return { status: 200, data: p };
    }
  },

  'DELETE /api/portfolios/:id': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      // A College Administrator can remove a submission from the system
      // (e.g. a test entry or an outdated course). It needs an explicit
      // confirmation, is logged, and the faculty member is notified.
      if (ctx.user.role === 'admin' && p.facultyId !== ctx.user.id) {
        if (p.status === 'Draft') {
          throw { status: 409, message: 'Drafts belong to the faculty member and can only be deleted by them.' };
        }
        if (String(body.confirmCourseCode || '').trim().toLowerCase() !== String(p.courseCode || '').trim().toLowerCase()) {
          throw { status: 400, message: `Type "${p.courseCode}" exactly to confirm.` };
        }
        const reason = String(body.reason || '').trim().slice(0, 500);
        (p.documents || []).forEach((d) => {
          const filePath = path.join(UPLOADS_DIR, d.storedName);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });
        db.portfolios = (db.portfolios || []).filter((x) => x.id !== p.id);
        const owner = (db.users || []).find((u) => u.id === p.facultyId);
        pushAudit(db, {
          actor: ctx.user.id,
          action: 'delete',
          portfolioId: p.id,
          detail: `Deleted ${p.status.toLowerCase()} submission ${p.courseCode}${owner ? ` by ${owner.name}` : ''}${reason ? ` — ${reason}` : ''}`
        });
        pushNotification(db, {
          userId: p.facultyId,
          title: 'Submission Removed',
          message: `Your ${p.courseCode} portfolio was removed by ${ctx.user.name}.${reason ? ` Reason: ${reason}` : ''}`,
          portfolioId: null
        });
        return { status: 200, data: { ok: true } };
      }
      if (p.facultyId !== ctx.user.id) {
        throw { status: 403, message: 'Only the owning faculty member can delete this portfolio.' };
      }
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This portfolio is ${p.status.toLowerCase()} and can no longer be deleted.` };
      }
      (p.documents || []).forEach((d) => {
        const filePath = path.join(UPLOADS_DIR, d.storedName);
        fs.existsSync(filePath) && fs.unlinkSync(filePath);
      });
      db.portfolios = (db.portfolios || []).filter((x) => x.id !== p.id);
      pushAudit(db, { actor: ctx.user.id, action: 'delete', portfolioId: p.id, detail: `Deleted draft ${p.courseCode || 'portfolio'}` });
      return { status: 200, data: { ok: true } };
    }
  },

  'POST /api/portfolios/:id/actions': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = (db.portfolios || []).find((x) => x.id === params.id);
      if (!p) throw { status: 404, message: 'Portfolio not found.' };
      const action = body.action;
      const comment = String(body.comment || '').trim();

      if (action === 'submit') {
        if (p.facultyId !== ctx.user.id) throw { status: 403, message: 'Only the owning faculty member can submit this portfolio.' };
        if (BLOCKS_RESUBMIT.includes(p.status)) {
          throw { status: 409, message: `This portfolio is already ${p.status.toLowerCase()} and cannot be submitted again.` };
        }
        if (!p.courseCode || !p.courseTitle) {
          throw { status: 400, message: 'Please complete the course code and course title before submitting.' };
        }
        const wasRevision = p.status === 'Revision Required';
        p.status = 'Pending Review';
        p.resubmitted = wasRevision;
        // Auto-fill the "Prepared by" signatory with the submitting faculty
        // member — the rest (Reviewed/Concurred/Approved) are filled in
        // during administrative review.
        if (!p.signatories) p.signatories = { preparedBy: [], reviewedBy: null, concurredBy: null, approvedBy: [] };
        if (!p.signatories.preparedBy || !p.signatories.preparedBy.length) {
          p.signatories.preparedBy = [{ name: ctx.user.name, date: store.nowIso().slice(0, 10) }];
        }
        p.updatedAt = store.nowIso();
        pushAudit(db, { actor: ctx.user.id, action: wasRevision ? 'resubmit' : 'submit', portfolioId: p.id, detail: `${wasRevision ? 'Resubmitted' : 'Submitted'} ${p.courseCode} for review` });
        pushNotification(db, {
          userId: p.facultyId,
          title: 'Submission Received',
          message: `Your ${p.courseCode} portfolio was received and is now pending review.`,
          portfolioId: p.id
        });
        pushNotification(db, {
          role: 'admin',
          title: 'New Submission',
          message: `${ctx.user.name} submitted ${p.courseCode} for review.`,
          portfolioId: p.id
        });
        return { status: 200, data: p };
      }

      if (action === 'approve') {
        requireRole(ctx, ['admin']);
        p.status = 'Approved';
        p.updatedAt = store.nowIso();
        p.review = { notes: comment, requestedRevisionAt: null, approvedAt: store.nowIso() };
        if (!p.signatories) p.signatories = { preparedBy: [], reviewedBy: null, concurredBy: null, approvedBy: [] };
        p.signatories.reviewedBy = { name: ctx.user.name, date: store.nowIso().slice(0, 10) };
        pushAudit(db, { actor: ctx.user.id, action: 'approve', portfolioId: p.id, detail: `Approved ${p.courseCode}` });
        pushNotification(db, {
          userId: p.facultyId,
          title: 'Portfolio Approved',
          message: `Your ${p.courseCode} portfolio has been approved.`,
          portfolioId: p.id
        });
        return { status: 200, data: p };
      }

      if (action === 'request-revision') {
        requireRole(ctx, ['admin']);
        p.status = 'Revision Required';
        p.resubmitted = false;
        p.updatedAt = store.nowIso();
        p.review = { notes: comment, requestedRevisionAt: store.nowIso(), approvedAt: null };
        pushAudit(db, { actor: ctx.user.id, action: 'request-revision', portfolioId: p.id, detail: `Requested revision on ${p.courseCode}${comment ? ': ' + comment : ''}` });
        pushNotification(db, {
          userId: p.facultyId,
          title: 'Revision Requested',
          message: `${p.courseCode} needs changes: ${comment || 'See admin comments.'}`,
          portfolioId: p.id
        });
        return { status: 200, data: p };
      }

      throw { status: 400, message: 'Unknown action.' };
    }
  },

  // ---- documents ----
  'POST /api/portfolios/:id/documents': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id) throw { status: 403, message: 'Only the owning faculty member can upload documents.' };
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This portfolio is ${p.status.toLowerCase()} and no longer accepts new documents.` };
      }
      const name = String(body.name || '').trim();
      const dataBase64 = body.dataBase64;
      if (!name || !dataBase64) throw { status: 400, message: 'A file name and file contents are required.' };
      const ext = docExtOf(name);
      if (!ALLOWED_DOC_EXT.includes(ext)) {
        throw { status: 400, message: 'Only PDF, DOCX, and PPTX files are supported.' };
      }
      let buffer;
      try {
        buffer = Buffer.from(dataBase64, 'base64');
      } catch (e) {
        throw { status: 400, message: 'The uploaded file could not be read.' };
      }
      if (!buffer.length) throw { status: 400, message: 'The uploaded file is empty.' };
      if (buffer.length > MAX_DOC_BYTES) {
        throw { status: 400, message: 'Files must be 15MB or smaller.' };
      }
      const docId = store.nextId('doc');
      const storedName = `${p.id}__${docId}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);
      const doc = { id: docId, name, type: ext.replace('.', '').toUpperCase(), size: buffer.length, storedName, uploadedAt: store.nowIso() };
      if (!p.documents) p.documents = [];
      p.documents.push(doc);
      p.documentCount = p.documents.length;
      p.updatedAt = store.nowIso();
      pushAudit(db, { actor: ctx.user.id, action: 'edit', portfolioId: p.id, detail: `Uploaded ${name} to ${p.courseCode || 'portfolio'}` });
      return { status: 201, data: p };
    }
  },

  'DELETE /api/portfolios/:id/documents/:docId': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id) throw { status: 403, message: 'Only the owning faculty member can remove documents.' };
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This portfolio is ${p.status.toLowerCase()} and its documents can no longer be changed.` };
      }
      const idx = (p.documents || []).findIndex((d) => d.id === params.docId);
      if (idx === -1) throw { status: 404, message: 'Document not found.' };
      const [removed] = p.documents.splice(idx, 1);
      const filePath = path.join(UPLOADS_DIR, removed.storedName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      p.documentCount = p.documents.length;
      p.updatedAt = store.nowIso();
      pushAudit(db, { actor: ctx.user.id, action: 'edit', portfolioId: p.id, detail: `Removed ${removed.name} from ${p.courseCode || 'portfolio'}` });
      return { status: 200, data: p };
    }
  },

  // ---- notifications ----
  'POST /api/notifications/:id/read': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const n = (db.notifications || []).find((x) => x.id === params.id);
      if (!n) throw { status: 404, message: 'Notification not found.' };
      if (n.userId && n.userId !== ctx.user.id) {
        throw { status: 403, message: "You cannot modify another user's notification." };
      }
      n.read = true;
      return { status: 200, data: n };
    }
  },

  'POST /api/notifications/read-all': {
    auth: true,
    handler: (db, ctx) => {
      (db.notifications || []).forEach((n) => {
        if (n.userId === ctx.user.id || n.role === ctx.user.role) n.read = true;
      });
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- settings (IT admin only) ----
  'GET /api/settings': {
    auth: true,
    handler: (db) => ({ status: 200, data: db.settings || {} })
  },

  'PUT /api/settings': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      const allowed = ['systemName', 'schoolName', 'schoolAddress'];
      const patch = {};
      allowed.forEach((k) => { if (body[k] !== undefined) patch[k] = String(body[k]); });
      db.settings = Object.assign({}, db.settings, patch, { updatedAt: store.nowIso() });
      pushAudit(db, { actor: ctx.user.id, action: 'settings-update', portfolioId: null, detail: 'Updated system settings' });
      return { status: 200, data: db.settings };
    }
  },

  // ---- users (IT admin only) ----
  'GET /api/users': {
    auth: true,
    roles: ['it'],
    handler: (db) => ({ status: 200, data: (db.users || []).map(stripPassword) })
  },

  'POST /api/users': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body) => {
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim();
      if (!name || !username || !body.role) {
        throw { status: 400, message: 'Name, username, and role are required.' };
      }
      if (!isRole(body.role)) throw { status: 400, message: 'Role must be one of: faculty, admin, it.' };
      if (!isEmail(username)) throw { status: 400, message: 'Use the person\'s email address as the username — sign-in codes are sent there.' };
      if (findUserByUsername(db, username) || (db.users || []).some((u) => userEmail(u) === username.toLowerCase())) {
        throw { status: 409, message: 'A user with that email already exists.' };
      }
      const password = body.password && String(body.password).length >= 6 ? String(body.password) : auth.makeToken().slice(0, 12);
      const user = {
        id: store.nextId('u'),
        name,
        username,
        role: String(body.role).toLowerCase(),
        email: username.toLowerCase(),
        createdVia: 'it-admin',
        passwordHash: auth.hashPassword(password)
      };
      if (!db.users) db.users = [];
      db.users.push(user);
      pushAudit(db, { actor: ctx.user.id, action: 'user-create', portfolioId: null, detail: `Created user ${user.username} (${user.role})` });
      return { status: 201, data: Object.assign(stripPassword(user), body.password ? {} : { temporaryPassword: password }) };
    }
  },

  'PUT /api/users/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const u = (db.users || []).find((x) => x.id === params.id);
      if (!u) throw { status: 404, message: 'User not found.' };
      if (body.role !== undefined && !isRole(body.role)) {
        throw { status: 400, message: 'Role must be one of: faculty, admin, it.' };
      }
      if (body.username !== undefined) {
        const existing = findUserByUsername(db, body.username);
        if (existing && existing.id !== u.id) throw { status: 409, message: 'A user with that username already exists.' };
      }
      if (body.username !== undefined && String(body.username).trim().toLowerCase() !== String(u.username).toLowerCase()) {
        assertNotProtected(u, ctx, 'renamed');
      }
      const newRole = body.role !== undefined ? String(body.role).toLowerCase() : u.role;
      if (newRole !== u.role) {
        assertNotProtected(u, ctx, 'changed to another role');
        if (u.id === ctx.user.id) throw { status: 400, message: 'You can\'t change your own role.' };
        if (u.role === 'it' && countIt(db) <= 1) {
          throw { status: 400, message: 'This is the only IT Administrator. Add another one before changing this role.' };
        }
      }
      const oldRole = u.role;
      ['name', 'username'].forEach((k) => {
        if (body[k] !== undefined) u[k] = String(body[k]);
      });
      u.role = newRole;
      if (newRole !== oldRole) {
        // New permissions take effect on their next sign-in.
        db.sessions = (db.sessions || []).filter((s) => s.userId !== u.id);
      }
      pushAudit(db, {
        actor: ctx.user.id,
        action: 'user-update',
        portfolioId: null,
        detail: newRole !== oldRole ? `Changed ${u.username}'s role from ${oldRole} to ${newRole}` : `Updated user ${u.username}`
      });
      return { status: 200, data: stripPassword(u) };
    }
  },

  // Removing an account is deliberate: the IT Administrator must re-enter
  // their own password and type the account's username, and the removed
  // person gets an email saying so. Their portfolios stay for the record.
  'DELETE /api/users/:id': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      if (params.id === ctx.user.id) throw { status: 400, message: 'You cannot delete your own account while signed in.' };
      const idx = (db.users || []).findIndex((x) => x.id === params.id);
      if (idx === -1) throw { status: 404, message: 'User not found.' };
      const target = db.users[idx];
      assertNotProtected(target, ctx, 'deleted');
      if (target.role === 'it' && countIt(db) <= 1) {
        throw { status: 400, message: 'You can\'t delete the only IT Administrator.' };
      }
      if (String(body.confirmUsername || '').trim().toLowerCase() !== String(target.username).toLowerCase()) {
        throw { status: 400, message: `Type "${target.username}" exactly to confirm.` };
      }
      if (!body.password || !auth.verifyPassword(String(body.password), ctx.user.passwordHash)) {
        // 403, not 401: a 401 would sign the IT Administrator out.
        throw { status: 403, message: 'Your password is incorrect. The account was not deleted.' };
      }
      db.users.splice(idx, 1);
      const removed = target;
      db.sessions = (db.sessions || []).filter((s) => s.userId !== removed.id);
      db.mfaChallenges = (db.mfaChallenges || []).filter((c) => c.userId !== removed.id);
      const kept = (db.portfolios || []).filter((p) => p.facultyId === removed.id).length;
      pushAudit(db, {
        actor: ctx.user.id,
        action: 'user-delete',
        portfolioId: null,
        detail: `Removed user ${removed.username} (${removed.role})${kept ? ` — ${kept} portfolio${kept === 1 ? '' : 's'} kept for records` : ''}`
      });
      return {
        status: 200,
        data: { ok: true, emailed: !!userEmail(removed) && (mailer.brevoConfigured() || mailer.devLogMode()) },
        afterCommit: accountNotice(removed, 'Your OBTLP account was removed', [
          `Your OBTLP Generator System account (${removed.username}) was removed by an IT Administrator (${ctx.user.name}) on ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}.`,
          'You can no longer sign in with it.',
          'If you think this was a mistake, please contact your college\'s IT Administrator.'
        ])
      };
    }
  },

  'POST /api/users/:id/password': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const u = (db.users || []).find((x) => x.id === params.id);
      if (!u) throw { status: 404, message: 'User not found.' };
      assertNotProtected(u, ctx, 'given a new password');
      if (!body.newPassword || String(body.newPassword).length < 6) {
        throw { status: 400, message: 'Password must be at least 6 characters.' };
      }
      u.passwordHash = auth.hashPassword(String(body.newPassword));
      forgetTrustedDevices(u);
      db.sessions = (db.sessions || []).filter((s) => s.userId !== u.id);
      pushAudit(db, { actor: ctx.user.id, action: 'password-change', portfolioId: null, detail: `Changed password for ${u.username}` });
      return {
        status: 200,
        data: { ok: true },
        afterCommit: u.id === ctx.user.id ? null : accountNotice(u, 'Your OBTLP password was reset', [
          `An IT Administrator (${ctx.user.name}) set a new password for your OBTLP Generator System account (${u.username}) on ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}.`,
          'Ask them for the new password, then change it from your Profile page after signing in.',
          'If you did not ask for this, contact your college\'s IT Administrator right away.'
        ])
      };
    }
  },

  // ---- backup (IT admin only) ----
  'POST /api/backup': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `db-backup-${stamp}.json`;
      fs.writeFileSync(path.join(BACKUPS_DIR, filename), JSON.stringify(db, null, 2), 'utf8');
      pushAudit(db, { actor: ctx.user.id, action: 'backup', portfolioId: null, detail: `Created backup ${filename}` });
      return { status: 200, data: { ok: true, filename } };
    }
  }
};

// Match a request method+path against the routes table (supports :id params).
function matchRoute(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;
    const routeParts = routePath.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: routes[key], params };
  }
  return null;
}

async function handleApi(req, res, pathname, query) {
  const match = matchRoute(req.method, pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    try {
      body = await readBody(req, 20 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  try {
    const runHandler = (db) => {
      let ctx = null;
      if (match.route.auth) {
        ctx = requireAuth(db, req);
        if (match.route.roles) requireRole(ctx, match.route.roles);
      }
      return match.route.handler(db, ctx, query, body, match.params, req);
    };

    // GET handlers never mutate `db` — skip the write-back and the shared
    // write-serialization queue entirely so a burst of read-only requests
    // (e.g. an admin page loading several panels at once) doesn't get
    // stuck running one-at-a-time behind each other's Mongo round-trips.
    // Every non-GET route still goes through transact() so writes stay
    // serialized and persisted.
    const result = req.method === 'GET'
      ? runHandler(await store.readDb())
      : (await store.transact(runHandler)).result;

    // Side effects that must only happen once the write is saved (e.g.
    // emailing a sign-in code) run here; if one fails, its error is sent.
    if (result.afterCommit) await result.afterCommit();
    sendJson(res, result.status, result.data);
  } catch (err) {
    if (err && err.status) {
      sendJson(res, err.status, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }
}

// ---------- document download (binary, not JSON) ----------

async function handleDocumentDownload(req, res, pathname) {
  // /api/portfolios/:id/documents/:docId/download
  const parts = pathname.split('/').filter(Boolean);
  const portfolioId = decodeURIComponent(parts[2]);
  const docId = decodeURIComponent(parts[4]);
  try {
    const db = await store.readDb();
    const ctx = requireAuth(db, req);
    const p = (db.portfolios || []).find((x) => x.id === portfolioId);
    if (!p) return sendJson(res, 404, { error: 'Portfolio not found.' });
    if (p.facultyId !== ctx.user.id && !['admin', 'it'].includes(ctx.user.role)) {
      return sendJson(res, 403, { error: 'You do not have access to this document.' });
    }
    const doc = (p.documents || []).find((d) => d.id === docId);
    if (!doc) return sendJson(res, 404, { error: 'Document not found.' });
    const filePath = path.join(UPLOADS_DIR, doc.storedName);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'File is missing from storage.' });
    const ext = docExtOf(doc.storedName);
    res.writeHead(200, {
      'Content-Type': DOC_MIME[ext] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${doc.name.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err && err.status) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}

// ---------- static file serving ----------

function serveStatic(req, res, urlPath) {
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 - Not Found');
      }
      res.writeHead(500);
      return res.end('Server error');
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(fullUrl.pathname);

    if (req.method === 'GET' && /^\/api\/portfolios\/[^/]+\/documents\/[^/]+\/download$/.test(pathname)) {
      return handleDocumentDownload(req, res, pathname);
    }

    if (pathname.startsWith('/api/')) {
      return handleApi(req, res, pathname, fullUrl.searchParams);
    }

    let urlPath = pathname;
    if (urlPath === '/') urlPath = '/index.html';
    if (urlPath.startsWith('/uploads/') || urlPath.startsWith('/backups/')) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    serveStatic(req, res, urlPath);
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('Server error');
  }
});

store.initDbIfMissing()
  // Adds/refreshes the official BS CS / BS IT 2026-2027 OBTLP templates
  // (see seed-templates.js). Idempotent and additive — never touches
  // users, portfolios, or templates an admin edited by hand. Runs on every
  // boot so a git push + Render redeploy is all it takes to update MongoDB.
  .then(() => require('./seed-templates').ensureOfficialTemplates(store))
  // Built-in IT Administrator from DEFAULT_IT_EMAIL / DEFAULT_IT_PASSWORD
  // (see seed-admin.js) — public sign-up only creates Faculty accounts.
  .then(() => require('./seed-admin').ensureDefaultItAdmin(store))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`OBTLP app running at: http://localhost:${PORT}`);
      console.log(`Open http://localhost:${PORT} in your browser to view the app.`);
    });
  })
  .catch((err) => {
    console.error('[db] Failed to initialize the database — server not started:', err);
    process.exit(1);
  });
