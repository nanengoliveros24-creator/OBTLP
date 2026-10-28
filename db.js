/*
  Client-side API wrapper for the OBTLP app.

  Talks to the server API in server.js, which persists to db.json on disk,
  so faculty, admin, and IT views (even in different browsers) see the same
  data.

  Session handling: a real login/registration issues a server-side session
  token. That token (plus a small display copy of the user) is kept in
  localStorage so pages know who is signed in and can send the token as
  "Authorization: Bearer <token>" on every request. There is NO default or
  fallback session -- if nothing is stored, the user is signed out and
  every page redirects to the sign-in screen.
*/

(function () {
  const SESSION_KEY = 'obtlp_session';

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.token && parsed.userId ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      /* ignore */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // "Trust this device": one random token per account, kept in this
  // browser (it survives sign-out on purpose). Sent with the password so
  // the server can skip the emailed code.
  const DEVICE_KEY = 'obtlp_trusted_devices';
  function readDevices() {
    try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeDevices(map) {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  const userKey = (u) => String(u || '').trim().toLowerCase();
  function getDeviceToken(username) { return readDevices()[userKey(username)] || null; }
  function saveDeviceToken(username, token) {
    const map = readDevices();
    map[userKey(username)] = token;
    writeDevices(map);
  }
  function clearDeviceToken(username) {
    const map = readDevices();
    if (username === undefined) { writeDevices({}); return; }
    delete map[userKey(username)];
    writeDevices(map);
  }

  // Redirect to sign-in when the session is missing/expired, unless we're
  // already there. Shared by every authenticated request.
  function forceSignOut() {
    clearSession();
    const here = (window.location.pathname.split('/').pop() || 'index.html');
    if (here !== 'index.html' && here !== 'register.html' && here !== '') {
      window.location.href = 'index.html?expired=1';
    }
  }

  async function req(path, options) {
    const session = getSession();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {});
    if (session && session.token) headers['Authorization'] = `Bearer ${session.token}`;
    const opts = Object.assign({}, options, { headers });

    let res;
    try {
      res = await fetch(path, opts);
    } catch (networkErr) {
      const err = new Error('Could not reach the server. Is server.js running?');
      err.cause = networkErr;
      throw err;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* no body */
    }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/login')) {
        forceSignOut();
      }
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Download a protected document as a real file save, using the same
  // bearer-token auth as every other request (a plain <a href> can't set
  // an Authorization header).
  async function downloadDocument(portfolioId, docId, filename) {
    const session = getSession();
    const headers = {};
    if (session && session.token) headers['Authorization'] = `Bearer ${session.token}`;
    const res = await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}/documents/${encodeURIComponent(docId)}/download`, { headers });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      if (res.status === 401) forceSignOut();
      throw new Error((data && data.error) || 'Could not download the file.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // An OBTLP template's own file, as a Blob (same bearer-token auth).
  async function getObtlpTemplateFile(id) {
    const session = getSession();
    const headers = {};
    if (session && session.token) headers['Authorization'] = `Bearer ${session.token}`;
    const res = await fetch(`/api/obtlp-templates/${encodeURIComponent(id)}/file`, { headers });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      if (res.status === 401) forceSignOut();
      throw new Error((data && data.error) || 'Could not open the file.');
    }
    return res.blob();
  }

  const api = {
    // ---- session ----
    getSession,
    setSession,
    clearSession,

    // ---- auth ----
    // No role is sent: the server uses the account's own role.
    login: (username, password) => req('/api/login', { method: 'POST', body: JSON.stringify({ username, password, deviceToken: getDeviceToken(username) || undefined }) }),
    // Email OTP (second sign-in step)
    loginEmail: (challengeId, email) => req('/api/login/email', { method: 'POST', body: JSON.stringify({ challengeId, email }) }),
    loginVerify: (challengeId, code, trustDevice) => req('/api/login/verify', { method: 'POST', body: JSON.stringify({ challengeId, code, trustDevice: !!trustDevice }) }),
    getDeviceToken,
    saveDeviceToken,
    clearDeviceToken,
    getTrustedDevices: () => req('/api/me/trusted-devices'),
    forgetTrustedDevices: () => req('/api/me/trusted-devices', { method: 'DELETE' }),
    loginResend: (challengeId) => req('/api/login/resend', { method: 'POST', body: JSON.stringify({ challengeId }) }),
    register: (body) => req('/api/register', { method: 'POST', body: JSON.stringify(body) }),
    setup: (body) => req('/api/setup', { method: 'POST', body: JSON.stringify(body) }),
    setupStatus: () => req('/api/setup-status'),
    logout: () => req('/api/logout', { method: 'POST' }).catch(() => {}),

    // ---- reads ----
    getState: () => req('/api/state'),
    getSettings: () => req('/api/settings'),
    getUsers: () => req('/api/users'),

    // ---- catalog (reusable course / department / academic year picks) ----
    getCatalog: () => req('/api/catalog'),
    addCatalogEntry: (body) => req('/api/catalog', { method: 'POST', body: JSON.stringify(body) }),

    // ---- course templates (official per-course content) ----
    getCourseTemplates: () => req('/api/course-templates'),
    createCourseTemplate: (body) => req('/api/course-templates', { method: 'POST', body: JSON.stringify(body) }),
    updateCourseTemplate: (id, body) => req(`/api/course-templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteCourseTemplate: (id) => req(`/api/course-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ---- departments / programs (Phase 1: Dept -> Program -> Course -> Template) ----
    getDepartments: () => req('/api/departments'),
    createDepartment: (body) => req('/api/departments', { method: 'POST', body: JSON.stringify(body) }),
    updateDepartment: (id, body) => req(`/api/departments/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteDepartment: (id) => req(`/api/departments/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    getPrograms: (departmentId) => req(`/api/programs${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ''}`),
    createProgram: (body) => req('/api/programs', { method: 'POST', body: JSON.stringify(body) }),
    updateProgram: (id, body) => req(`/api/programs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteProgram: (id) => req(`/api/programs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ---- OBTLP templates (data-driven blueprint) ----
    getObtlpTemplates: () => req('/api/obtlp-templates'),
    createObtlpTemplate: (body) => req('/api/obtlp-templates', { method: 'POST', body: JSON.stringify(body) }),
    updateObtlpTemplate: (id, body) => req(`/api/obtlp-templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteObtlpTemplate: (id) => req(`/api/obtlp-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    duplicateObtlpTemplate: (id, body) => req(`/api/obtlp-templates/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(body || {}) }),
    uploadObtlpTemplateFile: (id, body) => req(`/api/obtlp-templates/${encodeURIComponent(id)}/file`, { method: 'PUT', body: JSON.stringify(body) }),
    getObtlpTemplateFile,

    // ---- org profile (Vision/Mission/Core Values/Graduate Attributes, etc.) ----
    getOrgProfile: () => req('/api/org-profile'),
    updateOrgProfile: (body) => req('/api/org-profile', { method: 'PUT', body: JSON.stringify(body) }),

    // ---- portfolios ----
    createPortfolio: () => req('/api/portfolios', { method: 'POST', body: JSON.stringify({}) }),
    updatePortfolio: (id, body) => req(`/api/portfolios/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deletePortfolio: (id, body) => req(`/api/portfolios/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body || {}) }),
    submitForReview: (id, comment) =>
      req(`/api/portfolios/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'submit', comment }) }),
    approve: (id, comment) =>
      req(`/api/portfolios/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'approve', comment }) }),
    requestRevision: (id, comment) =>
      req(`/api/portfolios/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'request-revision', comment }) }),

    // ---- deadlines / reports / archive / versions ----
    getDeadlines: () => req('/api/deadlines'),
    saveDeadline: (body) => req('/api/deadlines', { method: 'POST', body: JSON.stringify(body) }),
    deleteDeadline: (id) => req(`/api/deadlines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    sendDeadlineReminders: () => req('/api/deadlines/send-reminders', { method: 'POST' }),
    getReport: (qs) => req(`/api/reports${qs ? `?${qs}` : ''}`),
    archivePortfolio: (id, archived) => req(`/api/portfolios/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ archived: archived !== false }) }),
    archiveTerm: (body) => req('/api/archive/term', { method: 'POST', body: JSON.stringify(body) }),
    duplicatePortfolio: (id, body) => req(`/api/portfolios/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(body || {}) }),
    getVersions: (id) => req(`/api/portfolios/${encodeURIComponent(id)}/versions`),
    addFeedback: (id, body) => req(`/api/portfolios/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
    updateFeedback: (id, fid, resolved) => req(`/api/portfolios/${encodeURIComponent(id)}/feedback/${encodeURIComponent(fid)}`, { method: 'PUT', body: JSON.stringify({ resolved: !!resolved }) }),
    deleteFeedback: (id, fid) => req(`/api/portfolios/${encodeURIComponent(id)}/feedback/${encodeURIComponent(fid)}`, { method: 'DELETE' }),
    saveCurriculum: (programId, curriculum) => req(`/api/programs/${encodeURIComponent(programId)}/curriculum`, { method: 'PUT', body: JSON.stringify({ curriculum }) }),
    getCurriculumCoverage: (qs) => req(`/api/curriculum/coverage?${qs}`),

    // ---- documents ----
    uploadDocument: (portfolioId, { name, dataBase64 }) =>
      req(`/api/portfolios/${encodeURIComponent(portfolioId)}/documents`, { method: 'POST', body: JSON.stringify({ name, dataBase64 }) }),
    deleteDocument: (portfolioId, docId) =>
      req(`/api/portfolios/${encodeURIComponent(portfolioId)}/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' }),
    downloadDocument,

    // ---- notifications ----
    markNotificationRead: (id) => req(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllRead: () => req('/api/notifications/read-all', { method: 'POST' }),

    // ---- settings (IT admin) ----
    updateSettings: (body) => req('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),

    // ---- users (IT admin) ----
    createUser: (body) => req('/api/users', { method: 'POST', body: JSON.stringify(body) }),
    updateUser: (id, body) => req(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteUser: (id, body) => req(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body || {}) }),
    changePassword: (id, newPassword) =>
      req(`/api/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),

    // ---- backup (IT admin) ----
    runBackup: () => req('/api/backup', { method: 'POST' }),

    // ---- profile (any role, own account) ----
    updateMe: (body) => req('/api/me', { method: 'PUT', body: JSON.stringify(body) }),
    changeMyPassword: (currentPassword, newPassword) =>
      req('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
  };

  window.__OBTLP_API__ = api;

  // Shared role / status wording, so every page names things the same way.
  // 'admin' is the Dean (the key is kept for existing accounts).
  const ROLE_LABEL = { faculty: 'Faculty', chair: 'Department Chair', admin: 'Dean', vpaa: 'VPAA', it: 'IT Administrator' };
  const ROLE_HOME = { faculty: 'dashboard.html', chair: 'admin.html', admin: 'admin.html', vpaa: 'admin.html', it: 'it-admin.html' };
  const STAGE_WAITING = { chair: 'Dept. Chair Review', admin: 'Dean Approval', vpaa: 'VPAA Approval' };
  // Parts of the OBTLP a reviewer can leave feedback on.
  window.OBTLP_FEEDBACK_PARTS = {
    general: 'General', courseInfo: 'Course Information', outcomes: 'Learning Outcomes (CILO)', soMap: 'Student Outcomes Map',
    plan: 'Teaching and Learning Plan', references: 'References', grading: 'Grading / Course Requirements', policies: 'Course Policies'
  };
  window.OBTLP_ROLES = {
    LABEL: ROLE_LABEL,
    REVIEWERS: ['chair', 'admin', 'vpaa'],
    label: (role) => ROLE_LABEL[role] || role || '',
    home: (role) => ROLE_HOME[role] || 'index.html',
    isReviewer: (role) => ['chair', 'admin', 'vpaa'].includes(role),
    // Where a pending OBTLP is in the approval chain.
    stageOf: (p) => (p && (p.status === 'Pending Review' || p.status === 'In Review')) ? (p.reviewStage || 'admin') : null,
    // "Pending – Dean Approval", or the plain status.
    statusText: (p) => {
      if (!p) return '';
      if (p.status === 'Pending Review' || p.status === 'In Review') return `Pending – ${STAGE_WAITING[p.reviewStage || 'admin']}`;
      return p.status;
    }
  };
})();
