/*
  Panel feedback (Oct 2026): Teacher = OBTLP author → Department Chair
  (approval) → Dean (final approval), with an optional VPAA step. Sign-in no
  longer asks for a user type; the role comes from the account.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

const IT_EMAIL = 'it@test.edu';
const IT_PASS = 'ItPass#123';
let server;
let depts;
before(async () => {
  server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS } });
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

async function submitted(fac, code, extra) {
  const d = await fac.post('/api/portfolios');
  await fac.put(`/api/portfolios/${d.data.id}`, Object.assign({ courseCode: code, courseTitle: `${code} title`, academicYear: '2026-2027' }, extra || {}));
  const s = await fac.post(`/api/portfolios/${d.data.id}/actions`, { action: 'submit' });
  assert.equal(s.status, 200);
  return s.data;
}

test('IT creates Department Chair, Dean and VPAA accounts', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  for (const [name, email, role, dept] of [
    ['CCS Chair', 'chair@test.edu', 'chair', 'CCS'],
    ['CCS Dean', 'dean@test.edu', 'admin', 'CCS'],
    ['COED Chair', 'coed.chair@test.edu', 'chair', 'COED'],
    ['The VPAA', 'vpaa@test.edu', 'vpaa', '']
  ]) {
    const r = await it.post('/api/users', { name, username: email, role, password: 'Review#Pass1', departmentId: dept ? deptId(dept) : undefined });
    assert.equal(r.status, 201, `${role} created`);
    assert.equal(r.data.role, role);
  }
  const vp = await signIn('vpaa@test.edu', 'Review#Pass1');
  assert.equal(vp.user.role, 'vpaa');
  assert.equal(vp.user.departmentId, undefined, 'the VPAA is university-wide');
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Teacher One', username: 'teacher@test.edu', password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CCS' });
});

test('Teacher → Department Chair → Dean (final) by default', async () => {
  const { c: fac, user: me } = await signIn('teacher@test.edu', 'Secret#01');
  const p = await submitted(fac, 'IT101');
  assert.equal(p.status, 'Pending Review');
  assert.equal(p.reviewStage, 'chair', 'goes to the Department Chair first');

  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const early = await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  assert.equal(early.status, 403, 'the Dean waits for the Chair');

  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  const a1 = await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'approve', comment: 'Looks good' });
  assert.equal(a1.status, 200);
  assert.equal(a1.data.status, 'Pending Review');
  assert.equal(a1.data.reviewStage, 'admin');
  assert.equal(a1.data.signatories.reviewedBy.name, 'CCS Chair');
  assert.equal((await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' })).status, 403, 'no double approval');

  const a2 = await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  assert.equal(a2.data.status, 'Approved');
  assert.equal(a2.data.signatories.approvedBy[0].name, 'CCS Dean');
  assert.deepEqual(a2.data.approvals.map((x) => x.stage), ['chair', 'admin']);

  const st = await fac.get('/api/state');
  const titles = st.data.notifications.filter((n) => n.userId === me.id).map((n) => n.title);
  assert.ok(titles.includes('Approved by the Department Chair'));
  assert.ok(titles.includes('OBTLP Approved'));
  assert.deepEqual(st.data.approvalChain, ['chair', 'admin']);
});

test('with the VPAA step on: Chair → Dean → VPAA', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  assert.equal((await it.put('/api/settings', { requireVpaaApproval: true })).status, 200);
  const { c: fac } = await signIn('teacher@test.edu', 'Secret#01');
  const p = await submitted(fac, 'IT102');
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  const { c: vpaa } = await signIn('vpaa@test.edu', 'Review#Pass1');
  await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  const d = await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  assert.equal(d.data.reviewStage, 'vpaa');
  assert.equal(d.data.signatories.concurredBy.name, 'CCS Dean');
  const v = await vpaa.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  assert.equal(v.data.status, 'Approved');
  assert.equal(v.data.signatories.approvedBy[0].name, 'The VPAA');
  await it.put('/api/settings', { requireVpaaApproval: false });
});

test('revision: the current reviewer or anyone above can send it back, with a comment', async () => {
  const { c: fac } = await signIn('teacher@test.edu', 'Secret#01');
  const p = await submitted(fac, 'IT103');
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  assert.equal((await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'request-revision' })).status, 400, 'comment required');
  const r = await dean.post(`/api/portfolios/${p.id}/actions`, { action: 'request-revision', comment: 'Fix week 3' });
  assert.equal(r.data.status, 'Revision Required');
  assert.equal(r.data.review.requestedByRole, 'admin');

  // Resubmitted → back to the Chair; then the Chair can't send back what the Dean holds.
  const again = await fac.post(`/api/portfolios/${p.id}/actions`, { action: 'submit' });
  assert.equal(again.data.reviewStage, 'chair');
  await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' });
  assert.equal((await chair.post(`/api/portfolios/${p.id}/actions`, { action: 'request-revision', comment: 'x' })).status, 403);
});

test('a college with no Department Chair account goes straight to the Dean; chairs only see their college', async () => {
  // COED has a chair; CBAA has nobody → waits for a Dean (stage admin).
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Biz Teacher', username: 'biz@test.edu', password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CBAA' });
  const { c: biz } = await signIn('biz@test.edu', 'Secret#01');
  const p = await submitted(biz, 'ACC101');
  assert.equal(p.reviewStage, 'admin');

  const { c: coedChair } = await signIn('coed.chair@test.edu', 'Review#Pass1');
  const st = await coedChair.get('/api/state');
  assert.ok(!st.data.portfolios.some((x) => x.courseCode === 'IT101' || x.courseCode === 'ACC101'));
  assert.equal(st.data.myDepartment.code, 'COED');

  // The VPAA sees every college.
  const { c: vpaa } = await signIn('vpaa@test.edu', 'Review#Pass1');
  const vs = await vpaa.get('/api/state');
  assert.ok(vs.data.portfolios.some((x) => x.courseCode === 'ACC101'));
  assert.ok(vs.data.portfolios.some((x) => x.courseCode === 'IT101'));
});

test('a faculty member cannot approve, and only the Dean can delete a submission', async () => {
  const { c: fac } = await signIn('teacher@test.edu', 'Secret#01');
  const p = await submitted(fac, 'IT104');
  assert.equal((await fac.post(`/api/portfolios/${p.id}/actions`, { action: 'approve' })).status, 403);
  const { c: chair } = await signIn('chair@test.edu', 'Review#Pass1');
  assert.equal((await chair.del(`/api/portfolios/${p.id}`, { confirmCourseCode: 'IT104' })).status, 403);
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  assert.equal((await dean.del(`/api/portfolios/${p.id}`, { confirmCourseCode: 'IT104' })).status, 200);
});
