/*
  College Administrators assigned to a department see and act on that
  department's portfolios only (CCS admin ↔ CCS, COED admin ↔ COED, …).
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

const IT_EMAIL = 'it@test.edu';
const IT_PASS = 'itpass123';
let server;
before(async () => { server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS } }); });
after(async () => { if (server) await server.stop(); });

async function signIn(username, password) {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `sign-in as ${username}`);
  c.setToken(r.data.token);
  return { c, user: r.data.user };
}

test('the six colleges exist', async () => {
  const { c } = await signIn(IT_EMAIL, IT_PASS);
  const codes = (await c.get('/api/departments')).data.map((d) => d.code).sort();
  ['CAS', 'CBAA', 'CCS', 'CHAS', 'COE', 'COED'].forEach((code) => assert.ok(codes.includes(code), code));
});

test('a CCS admin sees only CCS portfolios, a COED admin only COED ones', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const depts = (await it.get('/api/departments')).data;
  const ccs = depts.find((d) => d.code === 'CCS');
  const coed = depts.find((d) => d.code === 'COED');

  const mkAdmin = (name, email, departmentId) => it.post('/api/users', { name, username: email, role: 'admin', password: 'adminpass1', departmentId });
  assert.equal((await mkAdmin('CCS Dean', 'ccs.dean@test.edu', ccs.id)).status, 201);
  assert.equal((await mkAdmin('COED Dean', 'coed.dean@test.edu', coed.id)).status, 201);
  assert.equal((await it.post('/api/users', { name: 'All Dean', username: 'all.dean@test.edu', role: 'admin', password: 'adminpass1' })).status, 201);

  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'CS Prof', username: 'cs.prof@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  await pub.post('/api/register', { name: 'Ed Prof', username: 'ed.prof@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  const { c: csProf } = await signIn('cs.prof@test.edu', 'secret1');
  const { c: edProf } = await signIn('ed.prof@test.edu', 'secret1');

  const submit = async (client, fields) => {
    const p = (await client.post('/api/portfolios')).data;
    await client.put(`/api/portfolios/${p.id}`, Object.assign({ academicYear: '2026-2027' }, fields));
    await client.post(`/api/portfolios/${p.id}/actions`, { action: 'submit' });
    return p.id;
  };
  const csId = await submit(csProf, { courseCode: 'CCS101', courseTitle: 'Intro to Computing', departmentId: ccs.id });
  const edId = await submit(edProf, { courseCode: 'READ100', courseTitle: 'Reading', departmentId: coed.id });
  // An older portfolio with only the department NAME typed in is still sorted correctly.
  const legacyId = await submit(csProf, { courseCode: 'ITP 100', courseTitle: 'Old one', facultyDepartment: 'College of Computing Studies' });

  const { c: ccsAdmin } = await signIn('ccs.dean@test.edu', 'adminpass1');
  const ccsState = (await ccsAdmin.get('/api/state')).data;
  const ccsIds = ccsState.allPortfolios.map((p) => p.id).sort();
  assert.deepEqual(ccsIds, [csId, legacyId].sort());
  assert.equal(ccsState.myDepartment.code, 'CCS');
  assert.ok(!ccsState.users.some((u) => u.name === 'Ed Prof'), 'faculty of other departments are not listed');
  assert.ok(ccsState.notifications.every((n) => !n.portfolioId || n.portfolioId !== edId), 'no COED submission notices');

  // Can't act on another department's portfolio.
  assert.equal((await ccsAdmin.post(`/api/portfolios/${edId}/actions`, { action: 'approve' })).status, 404);
  assert.equal((await ccsAdmin.del(`/api/portfolios/${edId}`, { confirmCourseCode: 'READ100' })).status, 404);
  assert.equal((await ccsAdmin.post(`/api/portfolios/${csId}/actions`, { action: 'approve' })).status, 200);

  const { c: coedAdmin } = await signIn('coed.dean@test.edu', 'adminpass1');
  const coedState = (await coedAdmin.get('/api/state')).data;
  assert.deepEqual(coedState.allPortfolios.map((p) => p.id), [edId]);

  // Not assigned yet = sees every department (and the page says so).
  const { c: allAdmin } = await signIn('all.dean@test.edu', 'adminpass1');
  const allState = (await allAdmin.get('/api/state')).data;
  assert.equal(allState.myDepartment, null);
  assert.equal(allState.allPortfolios.length, 3);
});

test('the IT Administrator can assign or clear a College Administrator\'s department', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const users = (await it.get('/api/users')).data;
  const allDean = users.find((u) => u.username === 'all.dean@test.edu');
  const coed = (await it.get('/api/departments')).data.find((d) => d.code === 'COED');
  const set = await it.put(`/api/users/${allDean.id}`, { departmentId: coed.id });
  assert.equal(set.status, 200);
  assert.equal(set.data.departmentId, coed.id);
  assert.equal((await it.put(`/api/users/${allDean.id}`, { departmentId: 'nope' })).status, 400);
  const cleared = await it.put(`/api/users/${allDean.id}`, { departmentId: '' });
  assert.equal(cleared.data.departmentId, undefined);
});
