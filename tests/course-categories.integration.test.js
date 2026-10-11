/*
  Panel feedback (Oct 2026): separate templates for General Education and
  Specialized / Professional subjects; the system can generate a template
  from another; faculty can edit every part of the OBTLP and move it onto
  another template.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
  return { c, user: r.data.user };
}

test('Gen Ed and Specialized templates exist and courses are categorized', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const tpls = (await it.get('/api/obtlp-templates')).data;
  const ge = tpls.find((t) => t.code === 'GE-OBTLP-V1');
  const ccs = tpls.find((t) => t.code === 'CCS-OBTLP-V1');
  assert.equal(ge.courseCategory, 'gened');
  assert.equal(ge.departmentId, '', 'GE template is for every college');
  assert.equal(ccs.courseCategory, 'specialized');
  const courses = (await it.get('/api/course-templates')).data;
  const ent = courses.filter((c) => c.courseCode === 'ENT101');
  assert.ok(ent.length && ent.every((c) => c.courseCategory === 'gened' && c.obtlpTemplateId === ge.id));
  assert.ok(courses.filter((c) => c.courseCode === 'CCS101').every((c) => c.courseCategory === 'specialized'));
});

test('IT can generate a template from another and set its course type', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  const tpls = (await it.get('/api/obtlp-templates')).data;
  const ccs = tpls.find((t) => t.code === 'CCS-OBTLP-V1');
  const copy = await it.post(`/api/obtlp-templates/${ccs.id}/duplicate`, { name: 'CAS OBTLP' });
  assert.equal(copy.status, 201);
  assert.equal(copy.data.code, 'CCS-OBTLP-V1-COPY');
  assert.equal(copy.data.sections.length, ccs.sections.length);
  const second = await it.post(`/api/obtlp-templates/${ccs.id}/duplicate`, {});
  assert.equal(second.data.code, 'CCS-OBTLP-V1-COPY2');
  const upd = await it.put(`/api/obtlp-templates/${copy.data.id}`, { courseCategory: 'gened' });
  assert.equal(upd.data.courseCategory, 'gened');
  assert.equal((await it.put(`/api/obtlp-templates/${copy.data.id}`, { courseCategory: 'weird' })).data.courseCategory, '');
});

test('course templates are managed by IT; the Dean only monitors', async () => {
  const { c: it } = await signIn(IT_EMAIL, IT_PASS);
  await it.post('/api/users', { name: 'Dean', username: 'dean@test.edu', role: 'admin', password: 'Review#Pass1' });
  const { c: dean } = await signIn('dean@test.edu', 'Review#Pass1');
  assert.equal((await dean.post('/api/course-templates', { courseCode: 'X101' })).status, 403);
});

test('faculty can edit the whole OBTLP content and switch template', async () => {
  const pub = makeClient(server.baseUrl);
  await pub.post('/api/register', { name: 'Teacher', username: 't@test.edu', password: 'Secret#01', confirmPassword: 'Secret#01', departmentId: 'CCS' });
  const { c: fac } = await signIn('t@test.edu', 'Secret#01');
  const tpls = (await fac.get('/api/obtlp-templates')).data;
  const ge = tpls.find((t) => t.code === 'GE-OBTLP-V1');
  const p = (await fac.post('/api/portfolios')).data;
  const edits = {
    courseCode: 'ENT101', courseTitle: 'The Entrepreneurial Mind', academicYear: '2026-2027', description: 'Edited description',
    templateId: ge.id, courseCategory: 'gened',
    outcomes: ['CO one', 'CO two'],
    soMap: [{ soCode: 'SO1', intensity: 'I/L, E/P', description: 'Edited SO' }],
    teachingPlan: [{ type: 'week', week: '1', topics: ['Intro'], tla: ['Lecture'] }, { type: 'milestone', label: 'PRELIM EXAMINATION' }],
    grading: { components: [{ name: 'Lecture', weightPct: 100, items: [{ item: 'Quiz', source: 'Quizzes', pct: 100 }] }] },
    referenceGroups: { textbooks: ['Book A'], suggested: ['Reading B'] },
    courseRequirements: ['Business plan']
  };
  const r = await fac.put(`/api/portfolios/${p.id}`, edits);
  assert.equal(r.status, 200);
  assert.equal(r.data.templateId, ge.id);
  assert.equal(r.data.courseCategory, 'gened');
  assert.equal(r.data.soMap[0].description, 'Edited SO');
  assert.equal(r.data.teachingPlan[1].label, 'PRELIM EXAMINATION');
  assert.deepEqual(r.data.referenceGroups.suggested, ['Reading B']);
  assert.equal((await fac.put(`/api/portfolios/${p.id}`, { templateId: 'tpl_nope' })).status, 400);
});
