/*
  Each OBTLP template can hold its college's own copy of the form (PDF,
  DOCX or PPTX): IT inserts or replaces it, and anyone who can see the
  template can open it.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, makeClient } = require('./helpers');

const IT_EMAIL = 'it@test.edu';
const IT_PASS = 'ItPass#123';
let server;
before(async () => { server = await startServer({ env: { DEFAULT_IT_EMAIL: IT_EMAIL, DEFAULT_IT_PASSWORD: IT_PASS, OBTLP_DEADLINE_SWEEP: 'off' } }); });
after(async () => { if (server) await server.stop(); });

async function signIn(username, password) {
  const c = makeClient(server.baseUrl);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `sign-in as ${username}`);
  c.setToken(r.data.token);
  return { c, token: r.data.token };
}

async function getFile(token, id) {
  const res = await fetch(`${server.baseUrl}/api/obtlp-templates/${id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

const pdf = Buffer.from('%PDF-1.4\n% CCS OBTLP form\n%%EOF\n');
const docx = Buffer.from('PK\u0003\u0004 pretend docx');
const storedFiles = () => fs.readdirSync(path.join(server.dir, 'uploads')).filter((f) => f.startsWith('file__'));

test('IT inserts a file into a template and it opens with the same bytes', async () => {
  const { c: it, token } = await signIn(IT_EMAIL, IT_PASS);
  const ccs = (await it.get('/api/obtlp-templates')).data.find((t) => t.code === 'CCS-OBTLP-V1');
  assert.equal((await getFile(token, ccs.id)).status, 404, 'no file yet');

  const up = await it.put(`/api/obtlp-templates/${ccs.id}/file`, { name: 'CCS OBTLP form.pdf', dataBase64: pdf.toString('base64') });
  assert.equal(up.status, 200);
  assert.equal(up.data.file.name, 'CCS OBTLP form.pdf');
  assert.equal(up.data.file.type, 'PDF');
  assert.equal(up.data.file.size, pdf.length);

  const listed = (await it.get('/api/obtlp-templates')).data.find((t) => t.id === ccs.id);
  assert.equal(listed.file.id, up.data.file.id);

  const got = await getFile(token, ccs.id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.match(got.headers.get('content-disposition'), /^inline; filename="CCS OBTLP form.pdf"/);
  assert.deepEqual(got.body, pdf);
});

test('replacing the file keeps only the new one', async () => {
  const { c: it, token } = await signIn(IT_EMAIL, IT_PASS);
  const coed = (await it.get('/api/obtlp-templates')).data.find((t) => t.code === 'COED-CO-V1');
  const first = await it.put(`/api/obtlp-templates/${coed.id}/file`, { name: 'old.pdf', dataBase64: pdf.toString('base64') });
  const before = storedFiles().length;
  const second = await it.put(`/api/obtlp-templates/${coed.id}/file`, { name: 'Course Outline – COED.docx', dataBase64: docx.toString('base64') });
  assert.equal(second.status, 200);
  assert.notEqual(second.data.file.id, first.data.file.id);
  assert.equal(storedFiles().length, before, 'the old file is removed');
  const got = await getFile(token, coed.id);
  assert.deepEqual(got.body, docx);
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="Course Outline _ COED.docx"; filename\*=UTF-8''Course%20Outline%20%E2%80%93%20COED.docx/);
});

test('only IT can insert, only supported files are accepted, and readers can open it', async () => {
  const { c: it, token: itToken } = await signIn(IT_EMAIL, IT_PASS);
  const ccs = (await it.get('/api/obtlp-templates')).data.find((t) => t.code === 'CCS-OBTLP-V1');
  assert.equal((await it.put(`/api/obtlp-templates/${ccs.id}/file`, { name: 'form.exe', dataBase64: pdf.toString('base64') })).status, 400);
  assert.equal((await it.put(`/api/obtlp-templates/${ccs.id}/file`, { name: 'form.pdf', dataBase64: '' })).status, 400);
  assert.equal((await it.put('/api/obtlp-templates/nope/file', { name: 'form.pdf', dataBase64: pdf.toString('base64') })).status, 404);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  assert.equal((await it.put(`/api/obtlp-templates/${ccs.id}/file`, { name: 'big.pdf', dataBase64: big.toString('base64') })).status, 400);

  await it.post('/api/users', { name: 'Faculty', username: 'fac@test.edu', role: 'faculty', password: 'Faculty#Pass1' });
  const { c: fac, token: facToken } = await signIn('fac@test.edu', 'Faculty#Pass1');
  assert.equal((await fac.put(`/api/obtlp-templates/${ccs.id}/file`, { name: 'x.pdf', dataBase64: pdf.toString('base64') })).status, 403);
  assert.equal((await getFile(facToken, ccs.id)).status, 200, 'faculty can open an active template file');
  assert.equal((await fetch(`${server.baseUrl}/api/obtlp-templates/${ccs.id}/file`)).status, 401);
  assert.equal((await getFile(itToken, ccs.id)).status, 200);
});

test('a generated copy starts without a file, and deleting a template removes its file', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const ccs = (await it.get('/api/obtlp-templates')).data.find((t) => t.code === 'CCS-OBTLP-V1');
  const copy = (await it.post(`/api/obtlp-templates/${ccs.id}/duplicate`, { name: 'Copy' })).data;
  assert.equal(copy.file, undefined);
  const up = await it.put(`/api/obtlp-templates/${copy.id}/file`, { name: 'copy.pdf', dataBase64: pdf.toString('base64') });
  const before = storedFiles().length;
  assert.equal((await it.del(`/api/obtlp-templates/${copy.id}`)).status, 200);
  assert.equal(storedFiles().length, before - 1);
  assert.ok(!storedFiles().some((f) => f.includes(up.data.file.id)));
});
