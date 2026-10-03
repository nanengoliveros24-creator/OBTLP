/*
  Integration tests for the portfolio lifecycle: Draft -> Pending Review ->
  Approved / Revision Required, and the edit/resubmit guards around it.

  Run: node --test tests/portfolio-workflow.integration.test.js
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

let server;
let client;
let facultyToken;
let adminToken;

before(async () => {
  server = await startServer();
  client = makeClient(server.baseUrl);

  await client.post('/api/setup', { name: 'Root Admin', username: 'root-admin', password: 'adminpass1', role: 'admin' });
  await client.post('/api/register', { name: 'Prof One', username: 'prof-one@test.edu', password: 'facultypass1', confirmPassword: 'facultypass1' });

  const facultyLogin = await client.post('/api/login', { username: 'prof-one@test.edu', password: 'facultypass1' });
  facultyToken = facultyLogin.data.token;

  const adminLogin = await client.post('/api/login', { username: 'root-admin', password: 'adminpass1' });
  adminToken = adminLogin.data.token;
});

after(async () => {
  await server.stop();
});

test('a new portfolio starts in Draft', async () => {
  client.setToken(facultyToken);
  const res = await client.post('/api/portfolios', {});
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'Draft');
});

test('submitting without a course code/title is rejected', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  const res = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });
  assert.equal(res.status, 400);
});

test('a complete portfolio can be submitted and moves to Pending Review', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS101', courseTitle: 'Intro to Computing' });
  const res = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'Pending Review');
});

test('a Pending Review portfolio cannot be edited by its owner', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS102', courseTitle: 'Data Structures' });
  await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });

  const editAttempt = await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS102-CHANGED' });
  assert.equal(editAttempt.status, 409);
});

test('a Pending Review portfolio cannot be submitted a second time', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS103', courseTitle: 'Algorithms' });
  await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });

  const resubmit = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });
  assert.equal(resubmit.status, 409);
});

test('admin can approve a pending portfolio, and it becomes read-only', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS104', courseTitle: 'Databases' });
  await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });

  client.setToken(adminToken);
  const approve = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'approve' });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, 'Approved');

  client.setToken(facultyToken);
  const editAfterApproval = await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'SHOULD-NOT-APPLY' });
  assert.equal(editAfterApproval.status, 409);

  const deleteAfterApproval = await client.del(`/api/portfolios/${created.data.id}`);
  assert.equal(deleteAfterApproval.status, 409, 'an Approved portfolio must not be deletable either');
});

test('admin can request revision, and the faculty member can then edit and resubmit', async () => {
  client.setToken(facultyToken);
  const created = await client.post('/api/portfolios', {});
  await client.put(`/api/portfolios/${created.data.id}`, { courseCode: 'CCS105', courseTitle: 'Networks' });
  await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });

  client.setToken(adminToken);
  const revise = await client.post(`/api/portfolios/${created.data.id}/actions`, {
    action: 'request-revision',
    comment: 'Please add the grading breakdown.'
  });
  assert.equal(revise.status, 200);
  assert.equal(revise.data.status, 'Revision Required');

  client.setToken(facultyToken);
  const edit = await client.put(`/api/portfolios/${created.data.id}`, { description: 'Updated per admin feedback.' });
  assert.equal(edit.status, 200);

  const resubmit = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'submit' });
  assert.equal(resubmit.status, 200);
  assert.equal(resubmit.data.status, 'Pending Review');
  assert.equal(resubmit.data.resubmitted, true);
});
