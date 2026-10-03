/*
  Shared test harness.

  Each test file calls startServer() once (in an `after`/`before` pair) to
  boot a real copy of server.js as a child process, pointed at a throwaway
  db.json + uploads/backups folders under os.tmpdir(). This means tests:
    - never touch the real db.json
    - can run in parallel across files (each gets its own port + files)
    - exercise the ACTUAL server (routing, auth, RBAC) rather than
      re-implementing it in a mock
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Starts server.js as a child process with an isolated DB/uploads/backups
// dir and a random port. Resolves once the server has logged its "running
// at" line (or rejects on timeout/early exit).
function startServer(opts) {
  opts = opts || {};
  const dir = freshTmpDir('obtlp-test-');
  const dbPath = path.join(dir, 'db.json');
  fs.writeFileSync(dbPath, JSON.stringify({ users: [], portfolios: [], sessions: [] }, null, 2));
  const uploadsDir = path.join(dir, 'uploads');
  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  const port = 4000 + Math.floor(Math.random() * 5000);

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      OBTLP_DB_PATH: dbPath,
      OBTLP_UPLOADS_DIR: uploadsDir,
      OBTLP_BACKUPS_DIR: backupsDir,
      // Email OTP is off in tests unless a test opts in (see mfa test);
      // this also keeps a developer's own BREVO_* env vars from leaking in.
      MFA_DISABLED: opts.mfa ? '' : '1',
      MFA_DEV_LOG: opts.mfa ? '1' : '',
      BREVO_API_KEY: '',
      MAIL_FROM: '',
      DEFAULT_IT_EMAIL: '',
      DEFAULT_IT_PASSWORD: ''
    }, opts.env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Server did not start in time')); }
    }, 5000);

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (settled) return;
      if (chunk.toString().includes('running at')) {
        settled = true;
        clearTimeout(timer);
        resolve({
          baseUrl: `http://localhost:${port}`,
          dir,
          output: () => output,
          stop: () => new Promise((res) => {
            child.once('exit', res);
            child.kill();
          })
        });
      }
    });
    child.stderr.on('data', (chunk) => {
      // Surface server-side crashes during boot to make failures obvious.
      process.stderr.write(`[server stderr] ${chunk}`);
    });
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Server exited early (code ${code})`)); }
    });
  });
}

// Small fetch wrapper: keeps tests readable (client.post('/api/login', {...}))
// and threads the bearer token through automatically once you set it.
function makeClient(baseUrl) {
  let token = null;
  async function call(method, urlPath, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON response */ }
    return { status: res.status, data };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p, b) => call('DELETE', p, b),
    setToken: (t) => { token = t; },
    clearToken: () => { token = null; }
  };
}

module.exports = { startServer, makeClient };
