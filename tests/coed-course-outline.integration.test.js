/*
  College of Education Course Outline (PNC:AA-FO-44): seeded on start-up
  as its own department, program, portrait template and READ100 course,
  and a portfolio keeps the extra Course Outline fields when saved.
*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient } = require('./helpers');
const renderer = require('../templates-render.js');

let server;
before(async () => { server = await startServer(); });
after(async () => { if (server) await server.stop(); });

test('COED department, program, Course Outline template and READ100 are available', async () => {
  const c = makeClient(server.baseUrl);
  await c.post('/api/register', { name: 'Coed Prof', username: 'coed.prof@test.edu', password: 'secret1', confirmPassword: 'secret1' });
  const login = await c.post('/api/login', { username: 'coed.prof@test.edu', password: 'secret1' });
  c.setToken(login.data.token);

  const depts = (await c.get('/api/departments')).data;
  const coed = depts.find((d) => d.code === 'COED');
  assert.ok(coed, 'COED department exists');
  assert.equal(coed.name, 'College of Education');

  const tpls = (await c.get('/api/obtlp-templates')).data;
  const form = tpls.find((t) => t.code === 'COED-CO-V1');
  assert.ok(form);
  assert.equal(form.layout, 'course-outline');
  assert.equal(form.formCode, 'PNC:AA-FO-44 rev.0 06182026');

  const courses = (await c.get('/api/course-templates')).data;
  const read100 = courses.find((t) => t.courseCode === 'READ100');
  assert.ok(read100);
  assert.equal(read100.obtlpTemplateId, form.id);
  assert.equal(read100.departmentId, coed.id);
  assert.equal(read100.teachingPlan.length, 18);
  assert.equal(read100.soMap[0].group, 'Computer Science');
  assert.equal(read100.referenceGroups.suggested.length, 6);

  // CCS courses are untouched by the COED seed.
  assert.ok(courses.filter((t) => t.obtlpTemplateId !== form.id).length >= 26);

  // A portfolio keeps the Course Outline-only fields.
  const p = (await c.post('/api/portfolios')).data;
  const saved = await c.put(`/api/portfolios/${p.id}`, {
    courseCode: read100.courseCode, courseTitle: read100.courseTitle, templateId: form.id,
    soMap: read100.soMap, referenceGroups: read100.referenceGroups, officialMeta: read100.officialMeta
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.soMap[1].group, 'Nursing');
  assert.equal(saved.data.referenceGroups.suggested.length, 6);
  assert.equal(saved.data.officialMeta.soProgramLabel, 'COMPUTER SCIENCE AND NURSING');
  assert.equal(saved.data.officialMeta.gradingNotes[0], 'Passing: 60%');
  assert.equal(saved.data.officialMeta.signatories.approvedBy[0].title, 'Dean, COED');

  // Submitting records the faculty email printed on the form.
  await c.put(`/api/portfolios/${p.id}`, { academicYear: '2026-2027' });
  const sub = await c.post(`/api/portfolios/${p.id}/actions`, { action: 'submit' });
  assert.equal(sub.data.facultyEmail, 'coed.prof@test.edu');
});

test('the Course Outline renders as portrait pages with the COED letterhead', () => {
  const data = require('../data/coed-course-outlines-2026-2027.json');
  const course = data.courses[0];
  const template = { layout: 'course-outline', docTitle: 'COURSE OUTLINE', formCode: 'PNC:AA-FO-44 rev.0 06182026', secondaryLogo: 'assets/coed-logo.png', sections: [] };
  const html = renderer.renderSectionsHtml(template, Object.assign({}, course, {
    program: data.program, orgProfile: { coreValues: ['Personal Dignity'], graduateAttributes: ['Lifelong learner'] },
    faculty: 'Coed Prof', semester: '1st Semester', academicYear: '2026-2027'
  }));
  assert.match(html, /co-page/);
  assert.match(html, /COURSE OUTLINE/);
  assert.match(html, /College of Education/);
  assert.match(html, /coed-logo\.png/);
  assert.match(html, /Page <b>1<\/b> of <b>4<\/b>/);
  assert.match(html, /READ100 \(3 units\)/);
  assert.match(html, /Final Exam/);
});

test('the faculty "Department" list includes every official department', async () => {
  const c = makeClient(server.baseUrl);
  const login = await c.post('/api/login', { username: 'coed.prof@test.edu', password: 'secret1' });
  c.setToken(login.data.token);
  const cat = (await c.get('/api/catalog')).data;
  assert.ok(cat.departments.includes('College of Education'));
  assert.ok(cat.departments.includes('College of Computing Studies'));
});
