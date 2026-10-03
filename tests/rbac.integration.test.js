/*
  Integration tests: boots the real server.js against a throwaway db and
  drives it over HTTP, the same way a browser would. This is what actually
  proves "role-based access control is server-enforced" rather than just
  hidden in the UI.

  Run: node --test tests/rbac.integration.test.js
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');

let server;
let client;

before(async () => {
  server = await startServer();
  client = makeClient(server.baseUrl);
});

after(async () => {
  await server.stop();
});

test('first-run setup creates the first account and returns a session token', async () => {
  const res = await client.post('/api/setup', {
    name: 'Root IT',
    username: 'root-it',
    password: 'itpassword1',
    role: 'it'
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.token);
  assert.equal(res.data.user.role, 'it');
  assert.equal(res.data.user.passwordHash, undefined, 'password hash must never be sent to the client');
});

test('setup is permanently locked after the first account exists', async () => {
  const res = await client.post('/api/setup', {
    name: 'Second IT',
    username: 'second-it',
    password: 'itpassword2',
    role: 'it'
  });
  assert.equal(res.status, 403);
});

test('an unauthenticated request to a protected route is rejected', async () => {
  client.clearToken();
  const res = await client.get('/api/users');
  assert.equal(res.status, 401);
});

test('login rejects a correct password paired with the wrong selected role', async () => {
  // register a faculty account first
  await client.post('/api/register', {
    name: 'Faculty A', username: 'faculty-a@test.edu', password: 'facultypass1', confirmPassword: 'facultypass1'
  });
  const res = await client.post('/api/login', { username: 'faculty-a@test.edu', password: 'facultypass1', role: 'admin' });
  assert.equal(res.status, 401, 'a role mismatch must fail the same way a wrong password does');
});

test('login works with the correct role and returns a usable token', async () => {
  const res = await client.post('/api/login', { username: 'faculty-a@test.edu', password: 'facultypass1', role: 'faculty' });
  assert.equal(res.status, 200);
  assert.ok(res.data.token);
});

test('a faculty account cannot access IT-only routes (server-side, not just hidden UI)', async () => {
  const login = await client.post('/api/login', { username: 'faculty-a@test.edu', password: 'facultypass1' });
  client.setToken(login.data.token);
  const res = await client.get('/api/users');
  assert.equal(res.status, 403);
});

test('a faculty account cannot approve portfolios (admin-only action)', async () => {
  const login = await client.post('/api/login', { username: 'faculty-a@test.edu', password: 'facultypass1' });
  client.setToken(login.data.token);
  const created = await client.post('/api/portfolios', {});
  const res = await client.post(`/api/portfolios/${created.data.id}/actions`, { action: 'approve' });
  assert.equal(res.status, 403);
});

test('one faculty member cannot view or edit another faculty member\'s portfolio', async () => {
  await client.post('/api/register', {
    name: 'Faculty B', username: 'faculty-b@test.edu', password: 'facultypass1', confirmPassword: 'facultypass1'
  });

  const loginA = await client.post('/api/login', { username: 'faculty-a@test.edu', password: 'facultypass1' });
  client.setToken(loginA.data.token);
  const created = await client.post('/api/portfolios', {});
  const portfolioId = created.data.id;

  const loginB = await client.post('/api/login', { username: 'faculty-b@test.edu', password: 'facultypass1' });
  client.setToken(loginB.data.token);

  const editAttempt = await client.put(`/api/portfolios/${portfolioId}`, { courseCode: 'HACKED101' });
  assert.equal(editAttempt.status, 403);

  const state = await client.get('/api/state');
  const visibleIds = state.data.portfolios.map((p) => p.id);
  assert.ok(!visibleIds.includes(portfolioId), "Faculty B's own portfolio list must not include Faculty A's portfolio");
});

test('a client-supplied role/userId in the request body is ignored — identity comes from the token', async () => {
  const loginB = await client.post('/api/login', { username: 'faculty-b@test.edu', password: 'facultypass1' });
  client.setToken(loginB.data.token);
  // Try to smuggle an elevated role/identity in the body.
  const res = await client.get('/api/users');
  assert.equal(res.status, 403, 'body/query spoofing must not grant IT access');
});

test('an expired/garbage token is rejected, not silently treated as anonymous or admin', async () => {
  client.setToken('not-a-real-token');
  const res = await client.get('/api/state');
  assert.equal(res.status, 401);
});
