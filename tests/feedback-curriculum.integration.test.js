/*
  Panel feedback (Oct 2026):
  - feedback inside the actual document (per part), highlighted in the PDF;
  - the OBTLP is related to the college curriculum / plan of study, with a
    copy of the OBTLP per course in the plan.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

let pid;
test('setup', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  await it.post('/api/users', { name: 'Chair', username: 'chair@test.edu', role: 'chair', password: 'Review#Pass1', departmentId: deptId('CCS') });
  await it.post('/api/users', { name: 'Dean', username: 'dean@test.edu', role: 'admin', password: 'Review#Pass1', departmentId: deptId('CCS') });
  await it.post('/api/users', { name: 'COED Dean', username: 'coed.dean@test.edu', role: 'admin', password: 'Review#Pass1', departmentId: deptId('COED') });
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Teacher', username: 't@test.edu', password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CCS' });
  const { c: fac } = await signIn('t@test.edu', 'Secret#01');
  const p = (await fac.post('/api/portfolios')).data;
  await fac.put(`/api/portfolios/${p.id}`, { courseCode: 'CCS101', courseTitle: 'Introduction to Computing', academicYear: '2026-2027', semester: '1st Semester' });
  pid = p.id;
});

test('reviewers add feedback on parts of the OBTLP while it is being reviewed', async () => {
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  assert.equal((await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'plan', text: 'x' })).status, 409, 'not submitted yet');
  const { c: fac } = await signIn('t@test.edu', 'Secret#01');
  await fac.post(`/api/portfolios/${pid}/actions`, { action: 'submit' });
  assert.equal((await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'nope', text: 'x' })).status, 400);
  assert.equal((await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'plan', text: '' })).status, 400);
  const f1 = await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'plan', text: 'Week 5 TLA does not match CILO 2.' });
  assert.equal(f1.status, 201);
  const f2 = await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'grading', text: 'Lab items add up to 90%.' });
  assert.equal((await fac.post(`/api/portfolios/${pid}/feedback`, { part: 'plan', text: 'me' })).status, 403, 'faculty cannot add reviewer feedback');
  const { c: coed } = await signIn('coed.dean@test.edu', 'Review#Pass1');
  assert.equal((await coed.post(`/api/portfolios/${pid}/feedback`, { part: 'plan', text: 'x' })).status, 404, 'other colleges cannot see it');

  const rev = await chair.post(`/api/portfolios/${pid}/actions`, { action: 'request-revision', comment: 'See the highlighted notes.' });
  assert.equal(rev.status, 200);
  const st = await fac.get('/api/state');
  const p = st.data.portfolios.find((x) => x.id === pid);
  assert.equal(p.feedback.length, 2);
  assert.ok(st.data.notifications.some((n) => /2 notes highlighted/.test(n.message)));

  // Faculty marks one as addressed; only the author can delete.
  const done = await fac.put(`/api/portfolios/${pid}/feedback/${f1.data.id}`, { resolved: true });
  assert.equal(done.data.resolved, true);
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  assert.equal((await dean.del(`/api/portfolios/${pid}/feedback/${f2.data.id}`)).status, 403);
  assert.equal((await chair.del(`/api/portfolios/${pid}/feedback/${f2.data.id}`)).status, 200);
});

test('final approval closes any open feedback', async () => {
  const { c: fac } = await signIn('t@test.edu', 'Secret#01');
  await fac.post(`/api/portfolios/${pid}/actions`, { action: 'submit' });
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  await chair.post(`/api/portfolios/${pid}/feedback`, { part: 'general', text: 'Minor: fix spacing.' });
  await chair.post(`/api/portfolios/${pid}/actions`, { action: 'approve' });
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const a = await dean.post(`/api/portfolios/${pid}/actions`, { action: 'approve' });
  assert.equal(a.data.status, 'Approved');
  assert.ok(a.data.feedback.every((f) => f.resolved));
});

test('curriculum / plan of study and OBTLP coverage', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const progs = (await it.get('/api/programs')).data;
  const bscs = progs.find((p) => p.code === 'BSCS');
  const coedProg = progs.find((p) => p.departmentId === deptId('COED'));
  const curriculum = [
    { yearLevel: 1, semester: '1st Semester', courseCode: 'CCS101', courseTitle: 'Introduction to Computing', units: '3' },
    { yearLevel: 1, semester: '1st Semester', courseCode: 'CCS102', courseTitle: 'Computer Programming 1', units: '3' },
    { yearLevel: 1, semester: '1st Semester', courseCode: 'CCS102', courseTitle: 'duplicate is dropped' },
    { yearLevel: 9, semester: 'Whenever', courseCode: 'ENT101', courseTitle: 'The Entrepreneurial Mind', courseCategory: 'gened' }
  ];
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  const saved = await chair.put(`/api/programs/${bscs.id}/curriculum`, { curriculum });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.curriculum.length, 3);
  const ent = saved.data.curriculum.find((r) => r.courseCode === 'ENT101');
  assert.equal(ent.yearLevel, 6);
  assert.equal(ent.semester, '1st Semester');
  assert.equal(ent.courseCategory, 'gened');
  if (coedProg) assert.equal((await chair.put(`/api/programs/${coedProg.id}/curriculum`, { curriculum })).status, 403, 'another college');
  const { c: fac } = await signIn('t@test.edu', 'Secret#01');
  assert.equal((await fac.put(`/api/programs/${bscs.id}/curriculum`, { curriculum })).status, 403);

  const cov = await chair.get(`/api/curriculum/coverage?programId=${bscs.id}&academicYear=2026-2027&semester=${encodeURIComponent('1st Semester')}`);
  assert.equal(cov.status, 200);
  const row101 = cov.data.rows.find((r) => r.courseCode === 'CCS101');
  assert.equal(row101.status, 'Approved');
  assert.equal(row101.faculty, 'Teacher');
  assert.equal(cov.data.rows.find((r) => r.courseCode === 'CCS102').status, 'No OBTLP');
  assert.equal(cov.data.summary.missing, 2);
});
