/*
  General Education vs Specialized / Professional courses (panel feedback,
  Oct 2026): "separate templates for Gen Ed and specialized / professional
  subjects".

  Runs on every server start, after the CCS and COED seeds:
  - Additive and idempotent; never touches users, portfolios or settings.
  - Gives each OBTLP template a courseCategory ('gened', 'specialized' or
    '' for any) unless an IT Administrator already set one.
  - Creates the university-wide "General Education OBTLP" template (same
    official landscape form, worded for GE courses: GE outcomes instead of
    a program's student outcomes).
  - Marks the seeded course templates: GE courses (e.g. ENT101 The
    Entrepreneurial Mind, a CHED GE elective) use the GE template; the rest
    are Specialized / Professional. A course template an IT Administrator
    edited by hand (updatedBy set) keeps whatever it has.
*/
const { TEMPLATE_SECTIONS } = require('./seed-templates');

const GE_CODE = 'GE-OBTLP-V1';
// Course codes treated as General Education in the seeded data.
const GE_COURSES = ['ENT101'];

function geSections() {
  return TEMPLATE_SECTIONS.map((s) => {
    const copy = JSON.parse(JSON.stringify(s));
    if (s.type === 'programOutcomes') copy.label = 'GE Program Outcomes & Course Intended Learning Outcomes';
    if (s.type === 'soMatrix') copy.label = 'General Education Outcomes Addressed by the Course';
    return copy;
  });
}

function applyCourseCategories(db, store) {
  const now = store.nowIso();
  let changed = false;
  const log = (m) => console.log(`[seed-course-categories] ${m}`);
  if (!db.obtlpTemplates) db.obtlpTemplates = [];
  if (!db.courseTemplates) db.courseTemplates = [];

  db.obtlpTemplates.forEach((t) => {
    if (t.courseCategory !== undefined) return;
    t.courseCategory = t.code === 'CCS-OBTLP-V1' ? 'specialized' : '';
    changed = true;
  });

  let ge = db.obtlpTemplates.find((t) => t.code === GE_CODE);
  if (!ge) {
    const ccs = db.obtlpTemplates.find((t) => t.code === 'CCS-OBTLP-V1') || {};
    ge = {
      id: store.nextId('tpl'), code: GE_CODE, name: 'General Education OBTLP (all colleges)',
      departmentId: '', programId: '', version: '1', courseCategory: 'gened',
      formCode: ccs.formCode || 'PNC:AA-FO-06 rev.2 08182023', effectivityText: ccs.effectivityText || '',
      active: true, sections: geSections(), createdAt: now, updatedAt: now
    };
    db.obtlpTemplates.push(ge);
    changed = true; log(`template ${GE_CODE} created`);
  }

  db.courseTemplates.forEach((t) => {
    if (t.courseCategory !== undefined) return;
    const isGe = GE_COURSES.includes(String(t.courseCode || '').toUpperCase());
    t.courseCategory = isGe ? 'gened' : 'specialized';
    if (isGe && !t.updatedBy) t.obtlpTemplateId = ge.id;
    changed = true;
  });
  return changed;
}

async function ensureCourseCategories(store) {
  try {
    const db = await store.readDb();
    if (applyCourseCategories(db, store)) await store.writeDb(db);
  } catch (err) {
    console.error('[seed-course-categories] failed:', err && err.message ? err.message : err);
  }
}

module.exports = { ensureCourseCategories, applyCourseCategories, GE_CODE };
