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
const passwordPolicy = require('./password-policy');

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

function pushNotification(db, { userId, role, departmentId, title, message, portfolioId }) {
  if (!db.notifications) db.notifications = [];
  db.notifications.unshift({
    id: store.nextId('note'),
    userId: userId || null,
    role: role || null,
    departmentId: departmentId || null,
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

// Roles (RBAC). Panel feedback (Oct 2026): the OBTLP is written by the
// teacher and approved up the college hierarchy:
//   faculty (Teacher, author) → chair (Department Chair) → admin (Dean)
//   → vpaa (VPAA, only when Settings → "Require VPAA final approval" is on)
// 'admin' keeps its old key so existing accounts keep working; it is shown
// as "Dean" everywhere.
const ROLES = ['faculty', 'chair', 'admin', 'vpaa', 'it'];
const REVIEWER_ROLES = ['chair', 'admin', 'vpaa'];
const ROLE_LABEL = { faculty: 'Faculty', chair: 'Department Chair', admin: 'Dean', vpaa: 'VPAA', it: 'IT Administrator' };
function isRole(role) {
  return ROLES.includes(String(role || '').toLowerCase());
}
function isReviewer(user) {
  return !!user && REVIEWER_ROLES.includes(user.role);
}
// Roles that can be tied to one department (college).
const DEPT_ROLES = ['faculty', 'chair', 'admin'];

// The approval steps, in order. Dean is the final approver unless the IT
// Administrator turns on the VPAA step.
function approvalChain(db) {
  return (db.settings && db.settings.requireVpaaApproval) ? ['chair', 'admin', 'vpaa'] : ['chair', 'admin'];
}

// Everyone with this reviewer role who handles this portfolio.
function stageReviewers(db, stage, p) {
  return (db.users || []).filter((u) => u.role === stage && inAdminScope(db, u, p));
}

// The first step from position `fromIdx` on that has someone to act on it,
// so a college without a Department Chair (or VPAA) account yet doesn't get
// stuck. With nobody assigned to any later step, the Dean step is used if it
// is still ahead; null means there is no step left (fully approved).
function nextStage(db, p, fromIdx) {
  const chain = approvalChain(db);
  for (let i = fromIdx; i < chain.length; i++) {
    if (stageReviewers(db, chain[i], p).length) return chain[i];
  }
  return chain.indexOf('admin') >= fromIdx ? 'admin' : null;
}

// Older pending portfolios (from before the approval chain) wait for the Dean.
function currentStage(p) {
  if (p.status !== 'Pending Review' && p.status !== 'In Review') return null;
  return p.reviewStage || 'admin';
}

function notifyStage(db, p, stage, title, message) {
  stageReviewers(db, stage, p).forEach((u) => pushNotification(db, { userId: u.id, title, message, portfolioId: p.id }));
}

function pushHistory(p, entry) {
  if (!Array.isArray(p.reviewHistory)) p.reviewHistory = [];
  p.reviewHistory.push(Object.assign({ at: store.nowIso() }, entry));
  p.reviewHistory = p.reviewHistory.slice(-100);
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

// Throws a 400 with a clear message when a new password is too weak.
function assertStrongPassword(password) {
  const msg = passwordPolicy.problem(password);
  if (msg) throw { status: 400, message: msg };
}

// A password that passes the rules, for accounts an IT Administrator
// creates without typing a temporary password.
function generateTempPassword() {
  return passwordPolicy.generate((n) => crypto.randomInt(n), 12);
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
  if (isReviewer(me)) {
    // Last sign-in lets the College Administrator see which faculty are
    // active. Older accounts (before lastLoginAt existed) fall back to the
    // newest "signed in" entry in the activity log.
    const lastLoginFromLog = {};
    (db.auditLogs || []).forEach((l) => {
      if (l.action === 'login' && l.actor && !lastLoginFromLog[l.actor]) lastLoginFromLog[l.actor] = l.at;
    });
    // A department-scoped administrator only sees the faculty who have a
    // portfolio in their department.
    const scope = adminDepartmentId(db, me);
    const inDept = scope
      ? new Set((db.portfolios || []).filter((p) => inAdminScope(db, me, p)).map((p) => p.facultyId))
      : null;
    // Faculty are listed under their own department; a faculty member who
    // hasn't chosen one yet falls back to where their portfolios are.
    const inMyDept = (u) => (u.departmentId && findDepartment(db, u.departmentId)
      ? u.departmentId === scope
      : inDept.has(u.id));
    // Owners of portfolios in this department are included so their names
    // show in the review queue; only the department's own faculty are
    // flagged inDepartment (the Faculty list and "Active Faculty").
    return users
      .filter((u) => u.id === me.id || !inDept || (u.role === 'faculty' && (inMyDept(u) || inDept.has(u.id))))
      .map((u) => (u.id === me.id
        ? stripPassword(u)
        : {
          id: u.id, name: u.name, role: u.role,
          lastActiveAt: u.lastLoginAt || lastLoginFromLog[u.id] || null,
          departmentId: u.departmentId || null,
          inDepartment: !inDept || (u.role === 'faculty' && inMyDept(u))
        }));
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
  if (!p) throw { status: 404, message: 'OBTLP not found.' };
  if (p.facultyId !== ctx.user.id && !isReviewer(ctx.user) && ctx.user.role !== 'it') {
    throw { status: 403, message: 'You do not have access to this OBTLP.' };
  }
  // A College Administrator only handles their own department's portfolios;
  // another department's look exactly like ones that don't exist.
  if (p.facultyId !== ctx.user.id && !inAdminScope(db, ctx.user, p)) {
    throw { status: 404, message: 'OBTLP not found.' };
  }
  return p;
}

// ---------- department scoping for College Administrators ----------
// Each College Administrator can be assigned one department (CCS, COED,
// CAS, CHAS, COE, CBAA, …) by the IT Administrator. Once assigned, they see
// and act on that department's portfolios only. An administrator with no
// department assigned keeps seeing every department (the old behaviour),
// and the page tells them to ask the IT Administrator to assign one.
function findDepartment(db, id) {
  return (db.departments || []).find((d) => d.id === id) || null;
}

function portfolioDepartmentId(db, p) {
  if (p.departmentId && findDepartment(db, p.departmentId)) return p.departmentId;
  if (p.templateId) {
    const tpl = (db.obtlpTemplates || []).find((t) => t.id === p.templateId);
    if (tpl && tpl.departmentId && findDepartment(db, tpl.departmentId)) return tpl.departmentId;
  }
  const label = String(p.facultyDepartment || '').trim().toLowerCase();
  if (label) {
    const d = (db.departments || []).find((x) => String(x.name || '').trim().toLowerCase() === label
      || String(x.code || '').trim().toLowerCase() === label);
    if (d) return d.id;
  }
  // Last resort: the college of the faculty member who wrote it.
  const owner = (db.users || []).find((u) => u.id === p.facultyId);
  if (owner && owner.departmentId && findDepartment(db, owner.departmentId)) return owner.departmentId;
  return '';
}

// Department Chairs and Deans are tied to one college; the VPAA and IT
// see every college.
function adminDepartmentId(db, user) {
  if (!user || !['admin', 'chair'].includes(user.role) || !user.departmentId) return '';
  return findDepartment(db, user.departmentId) ? user.departmentId : '';
}

function portfolioProgramId(db, p) {
  if (p.programId) return p.programId;
  const ct = (db.courseTemplates || []).find((t) => String(t.courseCode || '').toLowerCase() === String(p.courseCode || '').toLowerCase());
  return (ct && ct.programId) || '';
}

function inAdminScope(db, user, p) {
  const scope = adminDepartmentId(db, user);
  if (scope && portfolioDepartmentId(db, p) !== scope) return false;
  // A Department Chair can also be tied to one program (e.g. BSIT).
  if (user && user.role === 'chair' && user.programId) {
    const prog = portfolioProgramId(db, p);
    if (prog && prog !== user.programId) return false;
  }
  return true;
}

function assertChairProgram(db, user, programId) {
  const prog = (db.programs || []).find((x) => x.id === programId);
  if (!prog) throw { status: 400, message: 'Selected program was not found.' };
  if (user.departmentId && prog.departmentId !== user.departmentId) {
    throw { status: 400, message: 'That program belongs to a different department.' };
  }
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
    description: String((row && row.description) || '').trim().slice(0, 2000),
    // which program the SO belongs to, when one course serves several
    // (e.g. the COED READ100 course outline: Computer Science / Nursing)
    group: String((row && row.group) || '').trim().slice(0, 200)
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
    journals: sanitizeStrList(src.journals),
    // "Suggested Readings and References" on the COED Course Outline form
    suggested: sanitizeStrList(src.suggested)
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
    // COED Course Outline (PNC:AA-FO-44) fields
    effectivityDate: str('effectivityDate', 100),
    supersedes: str('supersedes', 100),
    soProgramLabel: str('soProgramLabel', 300),
    programOutcomes: sanitizeStrList(src.programOutcomes),
    descriptionLead: str('descriptionLead', 200),
    gradingNotes: sanitizeStrList(src.gradingNotes),
    consultationOffice: str('consultationOffice', 200),
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

// General Education vs Specialized / Professional courses ('' = any).
const COURSE_CATEGORIES = ['gened', 'specialized'];
function sanitizeCategory(v) {
  const c = String(v || '').trim().toLowerCase();
  return COURSE_CATEGORIES.includes(c) ? c : '';
}

function blankStructuredFields() {
  return {
    departmentId: '',
    programId: '',
    prerequisite: '',
    soMap: [],
    teachingPlan: [],
    referenceGroups: { textbooks: [], onlineResources: [], journals: [], suggested: [] },
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
  // Every official department (CCS, COED, …) is always offered, even
  // before anyone has typed it in or used it on a portfolio.
  (db.departments || []).forEach((d) => {
    const name = String((d && d.name) || '').trim();
    if (name) departments.add(name);
  });
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


// ---------- Deadlines, reports, archive and versions (panel feedback) ----------
// - Deadlines: the Dean / VPAA / IT set when OBTLPs for a term are due
//   (per college or for every college); faculty who still need to submit
//   get reminders 7, 3 and 1 day(s) before and once when it is overdue.
// - Reports: late submissions, faculty who haven't submitted, and the
//   status of every OBTLP for a term.
// - Archive: approved OBTLPs from past terms are archived (kept read-only
//   and searchable) and can be reused as the basis of a new OBTLP.
// - Versions: every (re)submission keeps a snapshot so old and new can be
//   compared side by side.
const DAY_MS = 24 * 60 * 60 * 1000;
const SEMESTERS = ['1st Semester', '2nd Semester', 'Summer'];

function deadlineDueAt(d) {
  // End of the due date, Philippine time.
  return new Date(`${d.dueDate}T23:59:59+08:00`).getTime();
}

function sameTerm(p, academicYear, semester) {
  return String(p.academicYear || '').trim() === String(academicYear || '').trim()
    && String(p.semester || '').trim() === String(semester || '').trim();
}

// The deadline that applies to a portfolio: its college's own deadline
// for that term, otherwise a deadline for every college.
function deadlineFor(db, academicYear, semester, departmentId) {
  const list = (db.deadlines || []).filter((d) => d.academicYear === academicYear && d.semester === semester);
  return list.find((d) => d.departmentId && d.departmentId === departmentId) || list.find((d) => !d.departmentId) || null;
}

function portfolioDeadline(db, p) {
  return deadlineFor(db, String(p.academicYear || '').trim(), String(p.semester || '').trim(), portfolioDepartmentId(db, p));
}

function isLateSubmission(db, p) {
  const d = portfolioDeadline(db, p);
  const t = p.firstSubmittedAt || p.submittedAt;
  return !!(d && t && new Date(t).getTime() > deadlineDueAt(d));
}

function facultyForDeadline(db, d) {
  return (db.users || []).filter((u) => u.role === 'faculty' && (!d.departmentId || u.departmentId === d.departmentId));
}

// What a faculty member has for one term.
function facultyTermStatus(db, u, academicYear, semester) {
  const mine = (db.portfolios || []).filter((p) => p.facultyId === u.id && sameTerm(p, academicYear, semester));
  const submitted = mine.filter((p) => p.status !== 'Draft');
  const drafts = mine.filter((p) => p.status === 'Draft');
  const revision = mine.filter((p) => p.status === 'Revision Required');
  return { mine, submitted, drafts, revision, needsAction: !submitted.length || drafts.length > 0 || revision.length > 0 };
}

function fmtDue(d) {
  return new Date(`${d.dueDate}T12:00:00+08:00`).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
}

function reminderBucket(msLeft) {
  if (msLeft < 0) return 'overdue';
  if (msLeft <= DAY_MS) return '1';
  if (msLeft <= 3 * DAY_MS) return '3';
  if (msLeft <= 7 * DAY_MS) return '7';
  return null;
}

// Sends the reminders that are due now (each faculty member gets each
// reminder once). Returns email jobs to run after the write is saved.
function runDeadlineSweep(db, now) {
  const t = now || Date.now();
  const jobs = [];
  let sent = 0;
  (db.deadlines || []).forEach((d) => {
    const msLeft = deadlineDueAt(d) - t;
    if (msLeft < -14 * DAY_MS) return; // long past — stop reminding
    const bucket = reminderBucket(msLeft);
    if (!bucket) return;
    if (!d.reminded || typeof d.reminded !== 'object') d.reminded = {};
    facultyForDeadline(db, d).forEach((u) => {
      const st = facultyTermStatus(db, u, d.academicYear, d.semester);
      if (!st.needsAction) return;
      const already = d.reminded[u.id] || [];
      if (already.includes(bucket)) return;
      d.reminded[u.id] = already.concat(bucket);
      const term = `${d.semester} ${d.academicYear}`;
      const parts = [];
      if (st.drafts.length) parts.push(`${st.drafts.length} draft${st.drafts.length === 1 ? ' is' : 's are'} not submitted yet`);
      if (st.revision.length) parts.push(`${st.revision.length} OBTLP${st.revision.length === 1 ? ' needs' : 's need'} revision`);
      const what = parts.length
        ? `${parts.join(' and ')}.`.replace(/^./, (c) => c.toUpperCase())
        : 'You have not submitted an OBTLP for this term yet.';
      const title = bucket === 'overdue' ? 'OBTLP Deadline Passed' : 'OBTLP Deadline Reminder';
      const when = bucket === 'overdue'
        ? `was due on ${fmtDue(d)}`
        : `is due on ${fmtDue(d)} (${bucket === '1' ? 'tomorrow or today' : `in ${bucket} days or less`})`;
      const message = `Your OBTLP for ${term} ${when}. ${what}`;
      pushNotification(db, { userId: u.id, title, message, portfolioId: null });
      sent++;
      if (bucket !== '7') {
        const job = accountNotice(u, `${title}: ${term}`, [message, 'Sign in to the OBTLP Generator System to finish and submit it.']);
        if (job) jobs.push(job);
      }
    });
  });
  return { sent, jobs };
}

function sweepDeadlinesNow() {
  return store.transact((db) => runDeadlineSweep(db))
    .then(({ result }) => Promise.all(result.jobs.map((j) => j())).then(() => result.sent))
    .catch((err) => { console.error('[deadlines] reminder sweep failed:', (err && err.message) || err); return 0; });
}

// Reviewer feedback written on parts of the OBTLP itself (panel feedback:
// "feedback should be included inside the actual document and highlighted
// in the PDF / hard copy").
const FEEDBACK_PARTS = ['general', 'courseInfo', 'outcomes', 'soMap', 'plan', 'references', 'grading', 'policies'];

function findFeedback(p, fid) {
  const f = (p.feedback || []).find((x) => x.id === fid);
  if (!f) throw { status: 404, message: 'Feedback not found.' };
  return f;
}

// ---------- Curriculum / Plan of Study ----------
// Each program keeps its plan of study: which courses are taken in which
// year level and semester. OBTLPs are tied to it ("the OBTLP should be
// related to the curriculum of the college"), and the coverage view shows
// whether every course in the plan has an OBTLP for a term ("there should
// be a copy of the OBTLP per plan of study").
function sanitizeCurriculum(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, 400).map((r) => ({
    id: String((r && r.id) || '') || store.nextId('cur'),
    yearLevel: Math.min(6, Math.max(1, parseInt(r && r.yearLevel, 10) || 1)),
    semester: SEMESTERS.includes(String(r && r.semester)) ? String(r.semester) : '1st Semester',
    courseCode: String((r && r.courseCode) || '').trim().slice(0, 40),
    courseTitle: String((r && r.courseTitle) || '').trim().slice(0, 200),
    units: String((r && r.units) || '').trim().slice(0, 20),
    courseCategory: sanitizeCategory(r && r.courseCategory)
  })).filter((r) => {
    const key = `${r.yearLevel}|${r.semester}|${r.courseCode.toLowerCase()}`;
    if (!r.courseCode || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canEditCurriculum(db, user, program) {
  if (user.role === 'it') return true;
  if (user.role === 'admin') return !user.departmentId || user.departmentId === program.departmentId;
  if (user.role === 'chair') {
    return (!user.departmentId || user.departmentId === program.departmentId) && (!user.programId || user.programId === program.id);
  }
  return false;
}

const STATUS_RANK = { Approved: 4, 'Pending Review': 3, 'In Review': 3, 'Revision Required': 2, Draft: 1 };

// Fields compared between versions / terms.
const SNAPSHOT_FIELDS = ['courseCode', 'courseTitle', 'semester', 'academicYear', 'description', 'prerequisite',
  'objectives', 'outcomes', 'soMap', 'teachingPlan', 'referenceGroups', 'references', 'grading',
  'courseRequirements', 'classPoliciesOverride', 'templateId', 'facultyUnits', 'facultySchedule'];
const MAX_VERSIONS = 15;

function snapshotOf(p) {
  const snap = {};
  SNAPSHOT_FIELDS.forEach((k) => { if (p[k] !== undefined) snap[k] = JSON.parse(JSON.stringify(p[k])); });
  return snap;
}

// The portfolio as sent in /api/state: without the stored version
// snapshots (fetched on demand by the Compare page).
function lightPortfolio(db, p) {
  const copy = Object.assign({}, p);
  copy.versionCount = Array.isArray(p.versions) ? p.versions.length : 0;
  delete copy.versions;
  if (p.status !== 'Draft') copy.late = isLateSubmission(db, p);
  return copy;
}

// Dean, VPAA or IT; or a faculty member for their own OBTLP.
function canArchive(db, ctx, p) {
  if (p.facultyId === ctx.user.id) return true;
  if (['admin', 'vpaa', 'it'].includes(ctx.user.role)) return inAdminScope(db, ctx.user, p);
  return false;
}

function deadlineScopeFor(db, user, requested) {
  // Chairs and Deans set deadlines for their own college only.
  const own = adminDepartmentId(db, user);
  if (own) return own;
  const dep = String(requested || '');
  if (dep && !findDepartment(db, dep)) throw { status: 400, message: 'Selected department was not found.' };
  return dep;
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
      assertStrongPassword(password);
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
      assertStrongPassword(password);
      // Sign-in codes are emailed, so every new account needs a real email.
      if (!isEmail(username)) {
        throw { status: 400, message: 'Please use your email address (e.g. your Gmail) — sign-in codes are sent there.' };
      }
      if (findUserByUsername(db, username) || (db.users || []).some((u) => userEmail(u) === username.toLowerCase())) {
        throw { status: 409, message: 'An account with that email already exists.' };
      }
      // Each faculty member belongs to one college (their College
      // Administrator sees them in the Faculty list).
      // Accepts the department's id or its code (e.g. "CCS").
      const raw = String(body.departmentId || '').trim();
      const dep = findDepartment(db, raw)
        || (db.departments || []).find((d) => String(d.code || '').toLowerCase() === raw.toLowerCase());
      if (!raw || !dep) {
        throw { status: 400, message: 'Please choose your department.' };
      }
      const departmentId = dep.id;
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
        departmentId,
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
      if (!username || !password) {
        throw { status: 400, message: 'Email and password are required.' };
      }
      const user = findUserByUsername(db, username);
      if (!user) {
        throw { status: 401, message: 'Incorrect username or password.' };
      }
      if (!user.passwordHash || !auth.verifyPassword(password, user.passwordHash)) {
        throw { status: 401, message: 'Incorrect username or password.' };
      }
      // Accounts made before the strong-password rule can still sign in,
      // but are flagged so the app asks them to change their password.
      // Only a true/false flag is kept — never the password itself.
      if (passwordPolicy.isStrong(password)) delete user.passwordWeak;
      else user.passwordWeak = true;
      // No "user type" to pick at sign-in (panel feedback): the role comes
      // from the account itself, and any role sent by an older page is
      // ignored.
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
      // Faculty choose their own department; a College Administrator's is
      // assigned by the IT Administrator.
      if (body.departmentId !== undefined && ctx.user.role === 'faculty') {
        const next = String(body.departmentId || '');
        if (next && !findDepartment(db, next)) throw { status: 400, message: 'Selected department was not found.' };
        if (next) ctx.user.departmentId = next; else delete ctx.user.departmentId;
      }
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
      assertStrongPassword(newPassword);
      if (auth.verifyPassword(newPassword, ctx.user.passwordHash)) {
        throw { status: 400, message: 'Your new password must be different from your current password.' };
      }
      ctx.user.passwordHash = auth.hashPassword(newPassword);
      delete ctx.user.passwordWeak;
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
      const isStaff = isReviewer(ctx.user) || ctx.user.role === 'it';
      const scope = adminDepartmentId(db, ctx.user);
      const portfolios = (isStaff
        ? (db.portfolios || []).filter((p) => inAdminScope(db, ctx.user, p))
        : (db.portfolios || []).filter((p) => p.facultyId === ctx.user.id)).map((p) => lightPortfolio(db, p));
      const notifications = (db.notifications || []).filter(
        (n) => n.userId === ctx.user.id
          || (n.role === ctx.user.role && (!scope || !n.departmentId || n.departmentId === scope))
      );
      const scopedIds = scope ? new Set(portfolios.map((p) => p.id)) : null;
      const dept = scope ? findDepartment(db, scope) : null;
      return {
        status: 200,
        data: {
          users: visibleUsers(db, ctx.user),
          portfolios,
          allPortfolios: isStaff ? portfolios : [],
          // The department this College Administrator is assigned to (null =
          // not assigned yet, so every department is shown).
          myDepartment: isReviewer(ctx.user) ? (dept ? { id: dept.id, code: dept.code, name: dept.name } : null) : undefined,
          myProgram: ctx.user.role === 'chair' && ctx.user.programId
            ? (((db.programs || []).find((x) => x.id === ctx.user.programId)) || null)
            : undefined,
          // The approval steps in order, e.g. ['chair', 'admin'], or
          // ['chair', 'admin', 'vpaa'] when the VPAA step is on.
          approvalChain: approvalChain(db),
          // Submission deadlines that apply to this user.
          deadlines: (db.deadlines || []).filter((d) => {
            if (ctx.user.role === 'faculty') return !d.departmentId || d.departmentId === ctx.user.departmentId;
            const own = adminDepartmentId(db, ctx.user);
            return !own || !d.departmentId || d.departmentId === own;
          }).map((d) => ({ id: d.id, academicYear: d.academicYear, semester: d.semester, departmentId: d.departmentId || '', dueDate: d.dueDate, note: d.note || '' })),
          notifications,
          // Faculty get only their own activity (their sign-ins/edits and what
          // happened to their portfolios) for the dashboard timeline.
          auditLogs: isStaff
            ? (scopedIds
              ? (db.auditLogs || []).filter((l) => l.actor === ctx.user.id || (l.portfolioId && scopedIds.has(l.portfolioId))).slice(0, 50)
              : (db.auditLogs || []).slice(0, 50))
            : (db.auditLogs || []).filter((l) => l.actor === ctx.user.id || (l.portfolioId && portfolios.some((p) => p.id === l.portfolioId))).slice(0, 20),
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
  // The sign-up page needs the list of colleges before anyone is signed in.
  'GET /api/public/departments': {
    auth: false,
    handler: (db) => ({
      status: 200,
      data: (db.departments || []).map((d) => ({ id: d.id, code: d.code, name: d.name }))
        .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    })
  },

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

  // Department Chair (own program/college), Dean (own college) or IT.
  'PUT /api/programs/:id/curriculum': {
    auth: true,
    roles: ['chair', 'admin', 'it'],
    handler: (db, ctx, query, body, params) => {
      const program = (db.programs || []).find((p) => p.id === params.id);
      if (!program) throw { status: 404, message: 'Program not found.' };
      if (!canEditCurriculum(db, ctx.user, program)) throw { status: 403, message: 'You can only manage the curriculum of your own college or program.' };
      program.curriculum = sanitizeCurriculum(body.curriculum);
      program.curriculumUpdatedAt = store.nowIso();
      program.curriculumUpdatedBy = ctx.user.name;
      pushAudit(db, { actor: ctx.user.id, action: 'curriculum-update', portfolioId: null, detail: `Updated the ${program.code} plan of study (${program.curriculum.length} courses)` });
      return { status: 200, data: program };
    }
  },

  // Which courses in a program's plan of study have an OBTLP for a term.
  'GET /api/curriculum/coverage': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa', 'it'],
    handler: (db, ctx, query) => {
      const program = (db.programs || []).find((p) => p.id === String(query.get('programId') || ''));
      if (!program) throw { status: 404, message: 'Program not found.' };
      const academicYear = String(query.get('academicYear') || '').trim();
      const semester = String(query.get('semester') || '').trim();
      const userById = new Map((db.users || []).map((u) => [u.id, u]));
      const rows = (program.curriculum || []).filter((r) => !semester || r.semester === semester).map((r) => {
        const code = r.courseCode.toLowerCase();
        const matches = (db.portfolios || []).filter((p) => String(p.courseCode || '').trim().toLowerCase() === code
          && inAdminScope(db, ctx.user, p)
          && (!academicYear || String(p.academicYear || '').trim() === academicYear)
          && (!semester || String(p.semester || '').trim() === semester)
          && (!p.programId || p.programId === program.id));
        const best = matches.slice().sort((a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0))[0] || null;
        return Object.assign({}, r, {
          obtlps: matches.length,
          status: best ? best.status : 'No OBTLP',
          stage: best ? currentStage(best) : null,
          portfolioId: best ? best.id : null,
          faculty: best ? ((userById.get(best.facultyId) || {}).name || '') : ''
        });
      });
      const count = (fn) => rows.filter(fn).length;
      return {
        status: 200,
        data: {
          program: { id: program.id, code: program.code, name: program.name },
          term: { academicYear, semester },
          rows,
          summary: {
            courses: rows.length,
            approved: count((r) => r.status === 'Approved'),
            inProgress: count((r) => ['Pending Review', 'In Review', 'Revision Required', 'Draft'].includes(r.status)),
            missing: count((r) => r.status === 'No OBTLP')
          }
        }
      };
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
      const isStaff = isReviewer(ctx.user) || ctx.user.role === 'it';
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
        courseCategory: sanitizeCategory(body.courseCategory),
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
      if (body.courseCategory !== undefined) tpl.courseCategory = sanitizeCategory(body.courseCategory);
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

  // Generate a new template from an existing one (e.g. a Gen Ed version of
  // a college's form, or a template for another college), then adjust it.
  'POST /api/obtlp-templates/:id/duplicate': {
    auth: true,
    roles: ['it'],
    handler: (db, ctx, query, body, params) => {
      const src = (db.obtlpTemplates || []).find((t) => t.id === params.id);
      if (!src) throw { status: 404, message: 'OBTLP template not found.' };
      let code = String(body.code || '').trim() || `${src.code}-COPY`;
      const taken = (c) => db.obtlpTemplates.some((t) => t.code.toLowerCase() === c.toLowerCase());
      if (body.code && taken(code)) throw { status: 409, message: `A template with code ${code} already exists.` };
      for (let n = 2; taken(code); n++) code = `${src.code}-COPY${n}`;
      const departmentId = body.departmentId !== undefined ? String(body.departmentId || '') : (src.departmentId || '');
      if (departmentId && !findDepartment(db, departmentId)) throw { status: 400, message: 'Selected department was not found.' };
      const copy = Object.assign(JSON.parse(JSON.stringify(src)), {
        id: store.nextId('tpl'),
        code,
        name: String(body.name || '').trim() || `${src.name} (copy)`,
        departmentId,
        programId: body.departmentId !== undefined && departmentId !== src.departmentId ? '' : (src.programId || ''),
        courseCategory: body.courseCategory !== undefined ? sanitizeCategory(body.courseCategory) : (src.courseCategory || ''),
        version: '1',
        createdAt: store.nowIso(),
        updatedAt: store.nowIso(),
        duplicatedFrom: src.id
      });
      delete copy.madeDepartmentWide;
      db.obtlpTemplates.push(copy);
      pushAudit(db, { actor: ctx.user.id, action: 'obtlp-template-create', portfolioId: null, detail: `Generated OBTLP template ${code} from ${src.code}` });
      return { status: 201, data: copy };
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
    roles: ['it'],
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
        courseCategory: sanitizeCategory(body.courseCategory),
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
    roles: ['it'],
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
      if (body.courseCategory !== undefined) tpl.courseCategory = sanitizeCategory(body.courseCategory);
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
    roles: ['it'],
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
      pushAudit(db, { actor: ctx.user.id, action: 'create', portfolioId: id, detail: 'Created a new draft OBTLP' });
      return { status: 201, data: portfolio };
    }
  },

  'PUT /api/portfolios/:id': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id) {
        throw { status: 403, message: 'Only the owning faculty member can edit this OBTLP.' };
      }
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This OBTLP is ${p.status.toLowerCase()} and can no longer be edited.` };
      }
      if (body.departmentId !== undefined || body.programId !== undefined) {
        assertDeptProgramLink(db, body.departmentId !== undefined ? body.departmentId : p.departmentId, body.programId !== undefined ? body.programId : p.programId);
      }
      const stringFields = [
        'courseCode', 'courseTitle', 'semester', 'academicYear', 'description',
        'facultyDepartment', 'facultyUnits', 'facultySchedule', 'syllabus', 'notes',
        'departmentId', 'programId', 'templateId', 'prerequisite', 'classPoliciesOverride', 'effectivityText'
      ];
      if (body.templateId && !(db.obtlpTemplates || []).some((t) => t.id === String(body.templateId))) {
        throw { status: 400, message: 'Selected OBTLP template was not found.' };
      }
      stringFields.forEach((k) => {
        if (body[k] !== undefined) p[k] = String(body[k]);
      });
      if (body.courseCategory !== undefined) p.courseCategory = sanitizeCategory(body.courseCategory);
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
      pushAudit(db, { actor: p.facultyId, action: 'edit', portfolioId: p.id, detail: `Edited ${p.courseCode || 'OBTLP'}` });
      return { status: 200, data: p };
    }
  },

  'DELETE /api/portfolios/:id': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      // The Dean can remove a submission from the system
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
          message: `Your ${p.courseCode} OBTLP was removed by ${ctx.user.name}.${reason ? ` Reason: ${reason}` : ''}`,
          portfolioId: null
        });
        return { status: 200, data: { ok: true } };
      }
      if (p.facultyId !== ctx.user.id) {
        throw { status: 403, message: 'Only the owning faculty member can delete this OBTLP.' };
      }
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This OBTLP is ${p.status.toLowerCase()} and can no longer be deleted.` };
      }
      (p.documents || []).forEach((d) => {
        const filePath = path.join(UPLOADS_DIR, d.storedName);
        fs.existsSync(filePath) && fs.unlinkSync(filePath);
      });
      db.portfolios = (db.portfolios || []).filter((x) => x.id !== p.id);
      pushAudit(db, { actor: ctx.user.id, action: 'delete', portfolioId: p.id, detail: `Deleted draft ${p.courseCode || 'OBTLP'}` });
      return { status: 200, data: { ok: true } };
    }
  },

  'POST /api/portfolios/:id/actions': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = (db.portfolios || []).find((x) => x.id === params.id);
      if (!p) throw { status: 404, message: 'OBTLP not found.' };
      if (p.facultyId !== ctx.user.id && !inAdminScope(db, ctx.user, p)) {
        throw { status: 404, message: 'OBTLP not found.' };
      }
      const action = body.action;
      const comment = String(body.comment || '').trim();

      if (action === 'submit') {
        if (p.facultyId !== ctx.user.id) throw { status: 403, message: 'Only the owning faculty member can submit this OBTLP.' };
        if (BLOCKS_RESUBMIT.includes(p.status)) {
          throw { status: 409, message: `This OBTLP is already ${p.status.toLowerCase()} and cannot be submitted again.` };
        }
        if (!p.courseCode || !p.courseTitle) {
          throw { status: 400, message: 'Please complete the course code and course title before submitting.' };
        }
        const wasRevision = p.status === 'Revision Required';
        // Printed on forms that show the faculty's email (COED Course Outline).
        p.facultyEmail = userEmail(ctx.user) || p.facultyEmail || '';
        p.status = 'Pending Review';
        p.resubmitted = wasRevision;
        // Every (re)submission starts at the first approval step again.
        p.reviewStage = nextStage(db, p, 0);
        p.approvals = [];
        p.submittedAt = store.nowIso();
        if (!p.firstSubmittedAt) p.firstSubmittedAt = p.submittedAt;
        pushHistory(p, { action: wasRevision ? 'resubmit' : 'submit', by: ctx.user.id, byName: ctx.user.name, role: 'faculty' });
        // Keep what was submitted, so old and new versions can be compared.
        if (!Array.isArray(p.versions)) p.versions = [];
        p.versions.push({ no: (p.versions.length ? p.versions[p.versions.length - 1].no : 0) + 1, at: p.submittedAt, label: wasRevision ? 'Resubmitted' : 'Submitted', snapshot: snapshotOf(p) });
        p.versions = p.versions.slice(-MAX_VERSIONS);
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
          message: `Your ${p.courseCode} OBTLP was received and is now with the ${ROLE_LABEL[p.reviewStage]} for review.`,
          portfolioId: p.id
        });
        notifyStage(db, p, p.reviewStage, wasRevision ? 'Resubmitted OBTLP' : 'New OBTLP Submission',
          `${ctx.user.name} ${wasRevision ? 'resubmitted' : 'submitted'} ${p.courseCode} for your review.`);
        return { status: 200, data: p };
      }

      if (action === 'approve') {
        if (!isReviewer(ctx.user)) throw { status: 403, message: 'You do not have permission to perform this action.' };
        const stage = currentStage(p);
        if (!stage) throw { status: 409, message: `This OBTLP is ${String(p.status || '').toLowerCase()} and is not waiting for approval.` };
        if (stage !== ctx.user.role) {
          throw { status: 403, message: `This OBTLP is waiting for the ${ROLE_LABEL[stage] || stage}, not for you.` };
        }
        const chain = approvalChain(db);
        const idx = chain.indexOf(stage);
        const today = store.nowIso().slice(0, 10);
        const sig = { name: ctx.user.name, date: today };
        if (!p.signatories) p.signatories = { preparedBy: [], reviewedBy: null, concurredBy: null, approvedBy: [] };
        if (!Array.isArray(p.approvals)) p.approvals = [];
        p.approvals.push({ stage, by: ctx.user.id, byName: ctx.user.name, at: store.nowIso(), note: comment });
        pushHistory(p, { action: 'approve', stage, by: ctx.user.id, byName: ctx.user.name, role: ctx.user.role, note: comment });
        const next = idx >= 0 ? nextStage(db, p, idx + 1) : null;
        // Signatures on the official form: Reviewed by = Department Chair;
        // Approved by = the final approver (Dean, or VPAA when that step is
        // on — then the Dean signs "Recommending approval / Concurred by").
        if (stage === 'chair') p.signatories.reviewedBy = sig;
        else if (stage === 'admin' && next) p.signatories.concurredBy = sig;
        else p.signatories.approvedBy = [sig];
        p.updatedAt = store.nowIso();
        if (next) {
          p.reviewStage = next;
          pushAudit(db, { actor: ctx.user.id, action: 'endorse', portfolioId: p.id, detail: `${ROLE_LABEL[stage]} approved ${p.courseCode} and forwarded it to the ${ROLE_LABEL[next]}` });
          pushNotification(db, {
            userId: p.facultyId,
            title: `Approved by the ${ROLE_LABEL[stage]}`,
            message: `${p.courseCode} was approved by ${ctx.user.name} (${ROLE_LABEL[stage]}) and is now with the ${ROLE_LABEL[next]}.`,
            portfolioId: p.id
          });
          notifyStage(db, p, next, 'OBTLP for Your Approval', `${p.courseCode} was approved by the ${ROLE_LABEL[stage]} and now needs your approval.`);
          return { status: 200, data: p };
        }
        p.status = 'Approved';
        p.reviewStage = null;
        // The final, approved document carries no open review notes.
        (p.feedback || []).forEach((f) => { if (!f.resolved) { f.resolved = true; f.resolvedAt = store.nowIso(); f.resolvedBy = 'Final approval'; } });
        p.review = { notes: comment, requestedRevisionAt: null, approvedAt: store.nowIso(), approvedBy: ctx.user.name, approvedByRole: stage };
        pushAudit(db, { actor: ctx.user.id, action: 'approve', portfolioId: p.id, detail: `Final approval of ${p.courseCode} by the ${ROLE_LABEL[stage]}` });
        pushNotification(db, {
          userId: p.facultyId,
          title: 'OBTLP Approved',
          message: `Your ${p.courseCode} OBTLP has been given final approval by ${ctx.user.name} (${ROLE_LABEL[stage]}).`,
          portfolioId: p.id
        });
        return { status: 200, data: p };
      }

      if (action === 'request-revision') {
        if (!isReviewer(ctx.user)) throw { status: 403, message: 'You do not have permission to perform this action.' };
        const stage = currentStage(p);
        if (!stage) throw { status: 409, message: `This OBTLP is ${String(p.status || '').toLowerCase()} and is not waiting for review.` };
        // The reviewer at the current step, or anyone above it, can send it back.
        const chain = approvalChain(db).concat(['vpaa']);
        if (chain.indexOf(ctx.user.role) < chain.indexOf(stage)) {
          throw { status: 403, message: `This OBTLP is waiting for the ${ROLE_LABEL[stage] || stage}.` };
        }
        if (!comment) throw { status: 400, message: 'Please add a comment so the faculty member knows what to change.' };
        p.status = 'Revision Required';
        p.resubmitted = false;
        p.reviewStage = null;
        p.updatedAt = store.nowIso();
        p.review = { notes: comment, requestedRevisionAt: store.nowIso(), approvedAt: null, requestedBy: ctx.user.name, requestedByRole: ctx.user.role };
        pushHistory(p, { action: 'request-revision', stage, by: ctx.user.id, byName: ctx.user.name, role: ctx.user.role, note: comment });
        pushAudit(db, { actor: ctx.user.id, action: 'request-revision', portfolioId: p.id, detail: `${ROLE_LABEL[ctx.user.role]} requested revision on ${p.courseCode}${comment ? ': ' + comment : ''}` });
        const openNotes = (p.feedback || []).filter((f) => !f.resolved).length;
        pushNotification(db, {
          userId: p.facultyId,
          title: 'Revision Requested',
          message: `${p.courseCode} needs changes (${ROLE_LABEL[ctx.user.role]}): ${comment}${openNotes ? ` — ${openNotes} note${openNotes === 1 ? '' : 's'} highlighted in the document` : ''}`,
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
        throw { status: 409, message: `This OBTLP is ${p.status.toLowerCase()} and no longer accepts new documents.` };
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
      pushAudit(db, { actor: ctx.user.id, action: 'edit', portfolioId: p.id, detail: `Uploaded ${name} to ${p.courseCode || 'OBTLP'}` });
      return { status: 201, data: p };
    }
  },

  'DELETE /api/portfolios/:id/documents/:docId': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id) throw { status: 403, message: 'Only the owning faculty member can remove documents.' };
      if (!EDITABLE_STATUSES.includes(p.status)) {
        throw { status: 409, message: `This OBTLP is ${p.status.toLowerCase()} and its documents can no longer be changed.` };
      }
      const idx = (p.documents || []).findIndex((d) => d.id === params.docId);
      if (idx === -1) throw { status: 404, message: 'Document not found.' };
      const [removed] = p.documents.splice(idx, 1);
      const filePath = path.join(UPLOADS_DIR, removed.storedName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      p.documentCount = p.documents.length;
      p.updatedAt = store.nowIso();
      pushAudit(db, { actor: ctx.user.id, action: 'edit', portfolioId: p.id, detail: `Removed ${removed.name} from ${p.courseCode || 'OBTLP'}` });
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
      // Approval hierarchy: Dean is the final approver unless this is on.
      if (body.requireVpaaApproval !== undefined) patch.requireVpaaApproval = !!body.requireVpaaApproval;
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
      if (!isRole(body.role)) throw { status: 400, message: 'Role must be one of: faculty, chair, admin (Dean), vpaa, it.' };
      if (!isEmail(username)) throw { status: 400, message: 'Use the person\'s email address as the username — sign-in codes are sent there.' };
      if (findUserByUsername(db, username) || (db.users || []).some((u) => userEmail(u) === username.toLowerCase())) {
        throw { status: 409, message: 'A user with that email already exists.' };
      }
      const typedPassword = body.password ? String(body.password) : '';
      if (typedPassword) assertStrongPassword(typedPassword);
      const password = typedPassword || generateTempPassword();
      const user = {
        id: store.nextId('u'),
        name,
        username,
        role: String(body.role).toLowerCase(),
        email: username.toLowerCase(),
        createdVia: 'it-admin',
        passwordHash: auth.hashPassword(password)
      };
      if (DEPT_ROLES.includes(user.role) && body.departmentId) {
        if (!findDepartment(db, String(body.departmentId))) throw { status: 400, message: 'Selected department was not found.' };
        user.departmentId = String(body.departmentId);
      }
      if (user.role === 'chair' && body.programId) {
        assertChairProgram(db, user, String(body.programId));
        user.programId = String(body.programId);
      }
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
        throw { status: 400, message: 'Role must be one of: faculty, chair, admin (Dean), vpaa, it.' };
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
      // College Administrators are assigned one department ('' = all).
      let deptChanged = false;
      if (body.departmentId !== undefined) {
        const next = String(body.departmentId || '');
        if (next && !findDepartment(db, next)) throw { status: 400, message: 'Selected department was not found.' };
        if ((u.departmentId || '') !== next) { deptChanged = true; }
        if (next) u.departmentId = next; else delete u.departmentId;
      }
      if (!DEPT_ROLES.includes(newRole) && u.departmentId) { delete u.departmentId; }
      // A Department Chair can be tied to one program ('' = whole college).
      if (body.programId !== undefined && newRole === 'chair') {
        const prog = String(body.programId || '');
        if (prog) { assertChairProgram(db, u, prog); u.programId = prog; } else delete u.programId;
        deptChanged = true;
      }
      if (newRole !== 'chair' && u.programId) delete u.programId;
      if (newRole !== oldRole) {
        // New permissions take effect on their next sign-in.
        db.sessions = (db.sessions || []).filter((s) => s.userId !== u.id);
      }
      pushAudit(db, {
        actor: ctx.user.id,
        action: 'user-update',
        portfolioId: null,
        detail: newRole !== oldRole
          ? `Changed ${u.username}'s role from ${oldRole} to ${newRole}`
          : deptChanged
            ? `Assigned ${u.username} to ${u.departmentId ? (findDepartment(db, u.departmentId) || {}).name : 'all departments'}`
            : `Updated user ${u.username}`
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
        detail: `Removed user ${removed.username} (${removed.role})${kept ? ` — ${kept} OBTLP${kept === 1 ? '' : 's'} kept for records` : ''}`
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
      if (!body.newPassword) throw { status: 400, message: 'Please enter a new password.' };
      assertStrongPassword(String(body.newPassword));
      u.passwordHash = auth.hashPassword(String(body.newPassword));
      delete u.passwordWeak;
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


  // ---- submission deadlines ----
  'GET /api/deadlines': {
    auth: true,
    handler: (db, ctx) => {
      const own = ctx.user.role === 'faculty' ? (ctx.user.departmentId || '') : adminDepartmentId(db, ctx.user);
      const list = (db.deadlines || []).filter((d) => !own || !d.departmentId || d.departmentId === own || (ctx.user.role === 'faculty' && !ctx.user.departmentId));
      return { status: 200, data: list.map((d) => Object.assign({}, d, { reminded: undefined })) };
    }
  },

  'POST /api/deadlines': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa', 'it'],
    handler: (db, ctx, query, body) => {
      const academicYear = String(body.academicYear || '').trim();
      const semester = String(body.semester || '').trim();
      const dueDate = String(body.dueDate || '').trim();
      if (!/^\d{4}-\d{4}$/.test(academicYear)) throw { status: 400, message: 'Academic year must look like 2026-2027.' };
      if (!SEMESTERS.includes(semester)) throw { status: 400, message: 'Please choose a semester.' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(new Date(`${dueDate}T00:00:00Z`).getTime())) {
        throw { status: 400, message: 'Please choose a valid due date.' };
      }
      const departmentId = deadlineScopeFor(db, ctx.user, body.departmentId);
      if (!db.deadlines) db.deadlines = [];
      let d = db.deadlines.find((x) => x.academicYear === academicYear && x.semester === semester && (x.departmentId || '') === departmentId);
      const isNew = !d;
      if (!d) {
        d = { id: store.nextId('dl'), academicYear, semester, departmentId, createdAt: store.nowIso(), createdBy: ctx.user.id };
        db.deadlines.push(d);
      }
      if (d.dueDate !== dueDate) d.reminded = {};
      d.dueDate = dueDate;
      d.note = String(body.note || '').trim().slice(0, 500);
      d.updatedAt = store.nowIso();
      d.updatedBy = ctx.user.id;
      const dept = departmentId ? findDepartment(db, departmentId) : null;
      const term = `${semester} ${academicYear}`;
      facultyForDeadline(db, d).forEach((u) => pushNotification(db, {
        userId: u.id,
        title: isNew ? 'New OBTLP Deadline' : 'OBTLP Deadline Changed',
        message: `OBTLPs for ${term} are due on ${fmtDue(d)}.${d.note ? ` ${d.note}` : ''}`,
        portfolioId: null
      }));
      pushAudit(db, { actor: ctx.user.id, action: 'deadline', portfolioId: null, detail: `Set the OBTLP deadline for ${term}${dept ? ` (${dept.code})` : ' (all colleges)'} to ${dueDate}` });
      return { status: isNew ? 201 : 200, data: Object.assign({}, d, { reminded: undefined }) };
    }
  },

  'DELETE /api/deadlines/:id': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa', 'it'],
    handler: (db, ctx, query, body, params) => {
      const d = (db.deadlines || []).find((x) => x.id === params.id);
      if (!d) throw { status: 404, message: 'Deadline not found.' };
      const own = adminDepartmentId(db, ctx.user);
      if (own && d.departmentId !== own) throw { status: 403, message: 'You can only remove your own college\'s deadlines.' };
      db.deadlines = db.deadlines.filter((x) => x.id !== d.id);
      pushAudit(db, { actor: ctx.user.id, action: 'deadline', portfolioId: null, detail: `Removed the OBTLP deadline for ${d.semester} ${d.academicYear}` });
      return { status: 200, data: { ok: true } };
    }
  },

  // Sends any reminders that are due right now (they are also sent
  // automatically every hour).
  'POST /api/deadlines/send-reminders': {
    auth: true,
    roles: ['admin', 'vpaa', 'it'],
    handler: (db) => {
      const { sent, jobs } = runDeadlineSweep(db);
      return { status: 200, data: { sent }, afterCommit: jobs.length ? () => Promise.all(jobs.map((j) => j())) : null };
    }
  },

  // ---- reports (late / unsubmitted / status) ----
  'GET /api/reports': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa', 'it'],
    handler: (db, ctx, query) => {
      const own = adminDepartmentId(db, ctx.user);
      const deptFilter = own || String(query.get('departmentId') || '');
      const inScope = (db.portfolios || []).filter((p) => inAdminScope(db, ctx.user, p)
        && (!deptFilter || portfolioDepartmentId(db, p) === deptFilter));

      // Terms that exist (from deadlines and OBTLPs), newest first.
      const termKey = (ay, sem) => `${ay}|${sem}`;
      const terms = new Map();
      (db.deadlines || []).forEach((d) => terms.set(termKey(d.academicYear, d.semester), { academicYear: d.academicYear, semester: d.semester }));
      inScope.forEach((p) => { if (p.academicYear) terms.set(termKey(p.academicYear, p.semester), { academicYear: p.academicYear, semester: p.semester }); });
      const termList = Array.from(terms.values()).sort((a, b) => b.academicYear.localeCompare(a.academicYear) || SEMESTERS.indexOf(b.semester) - SEMESTERS.indexOf(a.semester));
      const academicYear = String(query.get('academicYear') || (termList[0] && termList[0].academicYear) || '');
      const semester = String(query.get('semester') || (termList[0] && termList[0].semester) || '1st Semester');

      const deadline = deadlineFor(db, academicYear, semester, deptFilter);
      const termPortfolios = inScope.filter((p) => sameTerm(p, academicYear, semester));
      const userById = new Map((db.users || []).map((u) => [u.id, u]));
      const deptOf = (id) => { const d = findDepartment(db, id); return d ? d.code : ''; };

      const facultyUsers = (db.users || []).filter((u) => u.role === 'faculty' && (!deptFilter || u.departmentId === deptFilter));
      const now = Date.now();
      const obtlps = termPortfolios.filter((p) => p.status !== 'Draft').map((p) => {
        const d = portfolioDeadline(db, p);
        const late = isLateSubmission(db, p);
        const submittedAt = p.firstSubmittedAt || p.submittedAt || null;
        return {
          id: p.id, courseCode: p.courseCode, courseTitle: p.courseTitle,
          faculty: (userById.get(p.facultyId) || {}).name || 'Faculty Member', facultyId: p.facultyId,
          department: deptOf(portfolioDepartmentId(db, p)),
          status: p.status, stage: currentStage(p), archived: !!p.archived,
          submittedAt, approvedAt: (p.review && p.review.approvedAt) || null,
          dueDate: d ? d.dueDate : null, late,
          daysLate: late && d ? Math.ceil((new Date(submittedAt).getTime() - deadlineDueAt(d)) / DAY_MS) : 0
        };
      });
      const faculty = facultyUsers.map((u) => {
        const st = facultyTermStatus(db, u, academicYear, semester);
        const mine = obtlps.filter((o) => o.facultyId === u.id);
        const first = mine.map((o) => o.submittedAt).filter(Boolean).sort()[0] || null;
        return {
          id: u.id, name: u.name, department: deptOf(u.departmentId),
          submitted: st.submitted.length, drafts: st.drafts.length,
          approved: mine.filter((o) => o.status === 'Approved').length,
          pending: mine.filter((o) => o.stage).length,
          revision: mine.filter((o) => o.status === 'Revision Required').length,
          late: mine.filter((o) => o.late).length,
          firstSubmittedAt: first,
          lastActiveAt: u.lastLoginAt || null,
          state: !st.submitted.length ? 'Not submitted' : (st.drafts.length ? 'Has unsubmitted drafts' : 'Submitted')
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const unsubmitted = faculty.filter((f) => f.state !== 'Submitted').map((f) => Object.assign({}, f, {
        draftCourses: termPortfolios.filter((p) => p.facultyId === f.id && p.status === 'Draft').map((p) => p.courseCode || 'Untitled')
      }));
      const late = obtlps.filter((o) => o.late).sort((a, b) => b.daysLate - a.daysLate);

      const byDepartment = (own ? (db.departments || []).filter((d) => d.id === own) : (db.departments || []))
        .filter((d) => !deptFilter || d.id === deptFilter)
        .map((d) => {
          const fac = faculty.filter((f) => f.department === d.code);
          const obs = obtlps.filter((o) => o.department === d.code);
          return {
            code: d.code, name: d.name, faculty: fac.length,
            submittedFaculty: fac.filter((f) => f.state === 'Submitted').length,
            unsubmittedFaculty: fac.filter((f) => f.state !== 'Submitted').length,
            obtlps: obs.length, approved: obs.filter((o) => o.status === 'Approved').length,
            pending: obs.filter((o) => o.stage).length, revision: obs.filter((o) => o.status === 'Revision Required').length,
            late: obs.filter((o) => o.late).length
          };
        });

      return {
        status: 200,
        data: {
          term: { academicYear, semester }, terms: termList, departmentId: deptFilter,
          deadline: deadline ? { dueDate: deadline.dueDate, note: deadline.note || '', departmentId: deadline.departmentId || '', overdue: deadlineDueAt(deadline) < now } : null,
          summary: {
            faculty: faculty.length,
            submittedFaculty: faculty.filter((f) => f.state === 'Submitted').length,
            unsubmittedFaculty: unsubmitted.length,
            obtlps: obtlps.length,
            approved: obtlps.filter((o) => o.status === 'Approved').length,
            pending: obtlps.filter((o) => o.stage).length,
            revision: obtlps.filter((o) => o.status === 'Revision Required').length,
            late: late.length,
            drafts: termPortfolios.filter((p) => p.status === 'Draft').length
          },
          faculty, unsubmitted, late, obtlps, byDepartment
        }
      };
    }
  },

  // ---- archive (past OBTLPs) ----
  'POST /api/portfolios/:id/archive': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (!canArchive(db, ctx, p)) throw { status: 403, message: 'You do not have permission to archive this OBTLP.' };
      const archive = body.archived !== false;
      if (archive && p.status !== 'Approved') throw { status: 409, message: 'Only approved OBTLPs can be archived.' };
      p.archived = archive;
      if (archive) { p.archivedAt = store.nowIso(); p.archivedBy = ctx.user.name; } else { delete p.archivedAt; delete p.archivedBy; }
      pushAudit(db, { actor: ctx.user.id, action: 'archive', portfolioId: p.id, detail: `${archive ? 'Archived' : 'Restored from the archive'} ${p.courseCode} (${p.semester} ${p.academicYear})` });
      return { status: 200, data: lightPortfolio(db, p) };
    }
  },

  // Archive every approved OBTLP of a past term at once.
  'POST /api/archive/term': {
    auth: true,
    roles: ['admin', 'vpaa', 'it'],
    handler: (db, ctx, query, body) => {
      const academicYear = String(body.academicYear || '').trim();
      const semester = String(body.semester || '').trim();
      if (!academicYear || !SEMESTERS.includes(semester)) throw { status: 400, message: 'Choose the academic year and semester to archive.' };
      let count = 0;
      (db.portfolios || []).forEach((p) => {
        if (p.status === 'Approved' && !p.archived && sameTerm(p, academicYear, semester) && inAdminScope(db, ctx.user, p)) {
          p.archived = true; p.archivedAt = store.nowIso(); p.archivedBy = ctx.user.name; count++;
        }
      });
      pushAudit(db, { actor: ctx.user.id, action: 'archive', portfolioId: null, detail: `Archived ${count} approved OBTLP${count === 1 ? '' : 's'} for ${semester} ${academicYear}` });
      return { status: 200, data: { archived: count } };
    }
  },

  // Start a new OBTLP from an earlier one (e.g. last year's archived OBTLP),
  // optionally for another term or on another OBTLP template.
  'POST /api/portfolios/:id/duplicate': {
    auth: true,
    roles: ['faculty'],
    handler: (db, ctx, query, body, params) => {
      const src = ownedPortfolio(db, params.id, ctx);
      if (src.facultyId !== ctx.user.id) throw { status: 403, message: 'You can only reuse your own OBTLPs.' };
      const templateId = body.templateId !== undefined ? String(body.templateId || '') : src.templateId;
      if (templateId && !(db.obtlpTemplates || []).some((t) => t.id === templateId)) throw { status: 400, message: 'Selected template was not found.' };
      const copy = JSON.parse(JSON.stringify(src));
      ['versions', 'reviewHistory', 'approvals', 'reviewStage', 'archived', 'archivedAt', 'archivedBy', 'submittedAt',
        'firstSubmittedAt', 'resubmitted', 'facultyEmail', 'feedback'].forEach((k) => delete copy[k]);
      Object.assign(copy, {
        id: store.nextId('p'),
        status: 'Draft',
        templateId,
        academicYear: body.academicYear !== undefined ? String(body.academicYear || '').trim() : '',
        semester: SEMESTERS.includes(String(body.semester || '')) ? String(body.semester) : src.semester,
        documents: [], documentCount: 0, notes: '',
        signatories: { preparedBy: [], reviewedBy: null, concurredBy: null, approvedBy: [] },
        review: { notes: '', requestedRevisionAt: null, approvedAt: null },
        basedOn: { id: src.id, courseCode: src.courseCode, academicYear: src.academicYear, semester: src.semester },
        createdAt: store.nowIso(), updatedAt: store.nowIso()
      });
      db.portfolios.push(copy);
      pushAudit(db, { actor: ctx.user.id, action: 'create', portfolioId: copy.id, detail: `Started a new OBTLP for ${copy.courseCode} from the ${src.semester} ${src.academicYear} version` });
      return { status: 201, data: copy };
    }
  },

  // ---- reviewer feedback inside the document ----
  'POST /api/portfolios/:id/feedback': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa'],
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (!currentStage(p)) throw { status: 409, message: 'Feedback can be added while the OBTLP is being reviewed.' };
      const part = String(body.part || 'general');
      if (!FEEDBACK_PARTS.includes(part)) throw { status: 400, message: 'Please choose which part of the OBTLP the feedback is about.' };
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) throw { status: 400, message: 'Please write the feedback.' };
      if (!Array.isArray(p.feedback)) p.feedback = [];
      const f = { id: store.nextId('fb'), part, text, by: ctx.user.id, byName: ctx.user.name, role: ctx.user.role, at: store.nowIso(), resolved: false };
      p.feedback.push(f);
      p.feedback = p.feedback.slice(-200);
      pushAudit(db, { actor: ctx.user.id, action: 'feedback', portfolioId: p.id, detail: `Added feedback on ${p.courseCode}` });
      return { status: 201, data: f };
    }
  },

  // The faculty member marks a note as addressed (or reopens it); reviewers can too.
  'PUT /api/portfolios/:id/feedback/:fid': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      if (p.facultyId !== ctx.user.id && !isReviewer(ctx.user)) throw { status: 403, message: 'You do not have permission to change this feedback.' };
      const f = findFeedback(p, params.fid);
      f.resolved = !!body.resolved;
      if (f.resolved) { f.resolvedAt = store.nowIso(); f.resolvedBy = ctx.user.name; } else { delete f.resolvedAt; delete f.resolvedBy; }
      return { status: 200, data: f };
    }
  },

  'DELETE /api/portfolios/:id/feedback/:fid': {
    auth: true,
    roles: ['chair', 'admin', 'vpaa'],
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      const f = findFeedback(p, params.fid);
      if (f.by !== ctx.user.id) throw { status: 403, message: 'You can only remove your own feedback.' };
      if (p.status === 'Approved') throw { status: 409, message: 'Feedback on an approved OBTLP is kept for the record.' };
      p.feedback = p.feedback.filter((x) => x.id !== f.id);
      return { status: 200, data: { ok: true } };
    }
  },

  // ---- versions (compare old and new) ----
  'GET /api/portfolios/:id/versions': {
    auth: true,
    handler: (db, ctx, query, body, params) => {
      const p = ownedPortfolio(db, params.id, ctx);
      const versions = (p.versions || []).map((v) => ({ no: v.no, at: v.at, label: v.label, snapshot: v.snapshot }));
      return {
        status: 200,
        data: {
          id: p.id, courseCode: p.courseCode, courseTitle: p.courseTitle, academicYear: p.academicYear, semester: p.semester,
          status: p.status, archived: !!p.archived,
          versions,
          current: snapshotOf(p)
        }
      };
    }
  },

  // ---- backup (IT admin only) ----
  'POST /api/backup': {
    auth: true,
    roles: ['it'],
    // Returns the backup to the IT Administrator's browser, which saves it
    // as a .json file on their computer. (Render's disk is wiped on every
    // redeploy, so a copy kept on the server would not survive.) Sign-in
    // secrets that are only useful while live are left out: sessions,
    // pending sign-in/reset codes and trusted-device tokens. Password
    // hashes stay so accounts can be restored — keep the file private.
    handler: (db, ctx) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `obtlp-backup-${stamp}.json`;
      pushAudit(db, { actor: ctx.user.id, action: 'backup', portfolioId: null, detail: `Downloaded backup ${filename}` });
      const copy = JSON.parse(JSON.stringify(db));
      delete copy._id;
      delete copy.sessions;
      delete copy.mfaChallenges;
      delete copy.resetChallenges;
      (copy.users || []).forEach((u) => { delete u.trustedDevices; });
      const backup = {
        format: 'obtlp-backup',
        version: 1,
        createdAt: store.nowIso(),
        createdBy: ctx.user.username,
        note: 'Uploaded document files (PDF/DOCX/PPTX) are not included; everything else in the database is.',
        counts: {
          users: (copy.users || []).length,
          portfolios: (copy.portfolios || []).length,
          courseTemplates: (copy.courseTemplates || []).length,
          departments: (copy.departments || []).length
        },
        data: copy
      };
      return { status: 200, data: { ok: true, filename, backup } };
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
    if (!p) return sendJson(res, 404, { error: 'OBTLP not found.' });
    if (p.facultyId !== ctx.user.id && !isReviewer(ctx.user) && ctx.user.role !== 'it') {
      return sendJson(res, 403, { error: 'You do not have access to this document.' });
    }
    if (p.facultyId !== ctx.user.id && !inAdminScope(db, ctx.user, p)) {
      return sendJson(res, 404, { error: 'OBTLP not found.' });
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
  // College of Education Course Outline (PNC:AA-FO-44) — see seed-coed.js.
  .then(() => require('./seed-coed').ensureCoedTemplates(store))
  // The six colleges (CCS, COED, CAS, CHAS, COE, CBAA) — see seed-departments.js.
  .then(() => require('./seed-departments').ensureDepartments(store))
  // General Education vs Specialized / Professional templates — see
  // seed-course-categories.js.
  .then(() => require('./seed-course-categories').ensureCourseCategories(store))
  // Built-in IT Administrator from DEFAULT_IT_EMAIL / DEFAULT_IT_PASSWORD
  // (see seed-admin.js) — public sign-up only creates Faculty accounts.
  .then(() => require('./seed-admin').ensureDefaultItAdmin(store))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`OBTLP app running at: http://localhost:${PORT}`);
      console.log(`Open http://localhost:${PORT} in your browser to view the app.`);
    });
    // Deadline reminders: shortly after start-up, then every hour.
    if (process.env.OBTLP_DEADLINE_SWEEP !== 'off') {
      setTimeout(sweepDeadlinesNow, 10 * 1000).unref();
      setInterval(sweepDeadlinesNow, 60 * 60 * 1000).unref();
    }
  })
  .catch((err) => {
    console.error('[db] Failed to initialize the database — server not started:', err);
    process.exit(1);
  });
