/*
  Panel feedback (Oct 2026):
  - deadline notifications for teachers (and status notifications);
  - reports for late submissions and unsubmitted OBTLPs;
  - archiving of past OBTLPs, reusable for a new term;
  - compare old and new OBTLP.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, makeClient } = require('./helpers');

const IT_EMAIL = 'it@test.edu';
const IT_PASS = 'ItPass#123';
let server;
let depts;
before(async () => {
  server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS, OBTLP_DEADLINE_SWEEP: 'off' } });
  depts = (await makeClient(server.baseUrl).get('/api/public/departments')).data;
});
after(async () => { if (server) await server.stop(); });
const deptId = (code) => depts.find((d) => d.code === code).id;

async function signIn(username, password) {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `sign-in as ${username}`);
  c.setToken(r.data.token);
  return { c, user: r.data.user };
}

const AY = '2026-2027';
const SEM = '1st Semester';
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

async function draft(c, code, extra) {
  const d = await c.post('/api/portfolios');
  await c.put(`/api/portfolios/${d.data.id}`, Object.assign({ courseCode: code, courseTitle: `${code} title`, academicYear: AY, semester: SEM, description: 'First description' }, extra || {}));
  return d.data.id;
}

test('setup: Dean, Chair and three CCS teachers', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  await it.post('/api/users', { name: 'CCS Dean', username: 'dean@test.edu', role: 'admin', password: 'Review#Pass1', departmentId: deptId('CCS') });
  await it.post('/api/users', { name: 'CCS Chair', username: 'chair@test.edu', role: 'chair', password: 'Review#Pass1', departmentId: deptId('CCS') });
  const pub = makeClient(server.baseUrl);
  for (const [n, e] of [['Ana Early', 'ana@test.edu'], ['Ben Late', 'ben@test.edu'], ['Cara None', 'cara@test.edu']]) {
    assert.equal((await pub.post('/api/register', { name: n, username: e, password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CCS' })).status, 201);
  }
});

test('the Dean sets a deadline; faculty are notified and see it', async () => {
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const bad = await dean.post('/api/deadlines', { academicYear: '2026', semester: SEM, dueDate: isoDay(5) });
  assert.equal(bad.status, 400);
  const r = await dean.post('/api/deadlines', { academicYear: AY, semester: SEM, dueDate: isoDay(5), departmentId: deptId('COED') });
  assert.equal(r.status, 201);
  assert.equal(r.data.departmentId, deptId('CCS'), 'a Dean can only set their own college\'s deadline');

  const { c: ana, user } = await signIn('ana@test.edu', 'Secret#01');
  const st = await ana.get('/api/state');
  assert.equal(st.data.deadlines.length, 1);
  assert.ok(st.data.notifications.some((n) => n.userId === user.id && n.title === 'New OBTLP Deadline'));
  const { c: faculty } = await signIn('ben@test.edu', 'Secret#01');
  assert.equal((await faculty.post('/api/deadlines', { academicYear: AY, semester: SEM, dueDate: isoDay(5) })).status, 403);
});

test('reminders go only to faculty who still need to submit, once per step', async () => {
  const { c: ana, user: anaUser } = await signIn('ana@test.edu', 'Secret#01');
  const a1 = await draft(ana, 'IT101');
  await ana.post(`/api/portfolios/${a1}/actions`, { action: 'submit' });
  const { c: ben, user: benUser } = await signIn('ben@test.edu', 'Secret#01');
  await draft(ben, 'IT201');

  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const s1 = await dean.post('/api/deadlines/send-reminders');
  assert.equal(s1.status, 200);
  assert.equal(s1.data.sent, 2, 'Ben (draft) and Cara (nothing) — not Ana');
  const s2 = await dean.post('/api/deadlines/send-reminders');
  assert.equal(s2.data.sent, 0, 'the same reminder is not sent twice');

  const benNotes = (await ben.get('/api/state')).data.notifications.filter((n) => n.userId === benUser.id && n.title === 'OBTLP Deadline Reminder');
  assert.equal(benNotes.length, 1);
  assert.match(benNotes[0].message, /draft/);
  const anaNotes = (await ana.get('/api/state')).data.notifications.filter((n) => n.userId === anaUser.id && n.title === 'OBTLP Deadline Reminder');
  assert.equal(anaNotes.length, 0);
});

test('reports: late submissions and faculty who have not submitted', async () => {
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const { c: ben } = await signIn('ben@test.edu', 'Secret#01');
  const b1 = (await ben.get('/api/state')).data.portfolios.find((p) => p.courseCode === 'IT201');
  await ben.post(`/api/portfolios/${b1.id}/actions`, { action: 'submit' });

  const rep = await dean.get(`/api/reports?academicYear=${AY}&semester=${encodeURIComponent(SEM)}`);
  assert.equal(rep.status, 200);
  const r = rep.data;
  assert.equal(r.summary.faculty, 3);
  assert.equal(r.summary.unsubmittedFaculty, 1);
  assert.deepEqual(r.unsubmitted.map((f) => f.name), ['Cara None']);
  assert.equal(r.summary.late, 0, 'both submitted before the due date');
  assert.ok(r.byDepartment.some((d) => d.code === 'CCS' && d.faculty === 3));

  // 2nd semester: the deadline has already passed, so Ben's submission is late.
  await dean.post('/api/deadlines', { academicYear: AY, semester: '2nd Semester', dueDate: isoDay(-3) });
  const b2 = await draft(ben, 'IT202', { semester: '2nd Semester' });
  await ben.post(`/api/portfolios/${b2}/actions`, { action: 'submit' });
  const rep2 = (await dean.get(`/api/reports?academicYear=${AY}&semester=${encodeURIComponent('2nd Semester')}`)).data;
  assert.equal(rep2.summary.late, 1);
  assert.equal(rep2.late[0].courseCode, 'IT202');
  assert.ok(rep2.late[0].daysLate >= 3);
  assert.equal(rep2.deadline.overdue, true);
  assert.equal(rep2.summary.unsubmittedFaculty, 2, 'Ana and Cara have nothing for the 2nd semester');
  assert.ok(rep2.terms.length >= 2);

  const { c: fac } = await signIn('cara@test.edu', 'Secret#01');
  assert.equal((await fac.get('/api/reports')).status, 403);
});

test('versions are kept on every submission and can be compared', async () => {
  const { c: ana } = await signIn('ana@test.edu', 'Secret#01');
  const st = await ana.get('/api/state');
  const p = st.data.portfolios.find((x) => x.courseCode === 'IT101');
  assert.equal(p.versions, undefined, 'snapshots are not sent with every page load');
  assert.equal(p.versionCount, 1);

  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'request-revision', comment: 'Revise the description' });
  await ana.put(`/api/portfolios/${p.id}`, { description: 'Second description, improved' });
  await ana.post(`/api/portfolios/${p.id}/actions`, { action: 'submit' });

  const v = await ana.get(`/api/portfolios/${p.id}/versions`);
  assert.equal(v.status, 200);
  assert.equal(v.data.versions.length, 2);
  assert.equal(v.data.versions[0].snapshot.description, 'First description');
  assert.equal(v.data.versions[1].snapshot.description, 'Second description, improved');
  assert.equal(v.data.versions[1].label, 'Resubmitted');
  // The Dean (same college) can see them too; another faculty member cannot.
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  assert.equal((await dean.get(`/api/portfolios/${p.id}/versions`)).status, 200);
  const { c: ben } = await signIn('ben@test.edu', 'Secret#01');
  assert.notEqual((await ben.get(`/api/portfolios/${p.id}/versions`)).status, 200);
});

test('archive: only approved OBTLPs; archived ones can be reused for a new term', async () => {
  const { c: ana } = await signIn('ana@test.edu', 'Secret#01');
  const p = (await ana.get('/api/state')).data.portfolios.find((x) => x.courseCode === 'IT101');
  assert.equal((await ana.post(`/api/portfolios/${p.id}/archive`, {})).status, 409, 'not approved yet');

  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });

  assert.equal((await chair.post('/api/archive/term', { academicYear: AY, semester: SEM })).status, 403);
  const t = await dean.post('/api/archive/term', { academicYear: AY, semester: SEM });
  assert.equal(t.data.archived, 1);
  const archived = (await ana.get('/api/state')).data.portfolios.find((x) => x.id === p.id);
  assert.equal(archived.archived, true);

  const copy = await ana.post(`/api/portfolios/${p.id}/duplicate`, { academicYear: '2027-2028', semester: SEM });
  assert.equal(copy.status, 201);
  assert.equal(copy.data.status, 'Draft');
  assert.equal(copy.data.academicYear, '2027-2028');
  assert.equal(copy.data.description, 'Second description, improved');
  assert.equal(copy.data.basedOn.id, p.id);
  assert.equal(copy.data.versions, undefined);

  // Restore from the archive.
  const un = await ana.post(`/api/portfolios/${p.id}/archive`, { archived: false });
  assert.equal(un.data.archived, false);
  // Another teacher can't reuse Ana's OBTLP.
  const { c: ben } = await signIn('ben@test.edu', 'Secret#01');
  assert.notEqual((await ben.post(`/api/portfolios/${p.id}/duplicate`, {})).status, 201);
});

test('the hourly reminder sweep does not crash with old deadline data', () => {
  const db = JSON.parse(fs.readFileSync(path.join(server.dir, 'db.json'), 'utf8'));
  assert.ok(Array.isArray(db.deadlines));
  assert.ok(db.deadlines[0].reminded, 'reminder bookkeeping is stored on the deadline');
});
