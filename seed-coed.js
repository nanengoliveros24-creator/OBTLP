/*
  College of Education (COED) — official Course Outline, 1st Sem AY 2026-2027.

  COED uses a different official form from the CCS OBTLP: the "COURSE
  OUTLINE" (PNC:AA-FO-44 rev.0 06182026), PORTRAIT on long bond paper
  (8.5" x 13"), with the College of Education seal on the right of the
  letterhead and a signature strip (Course Title / Prepared by / Reviewed
  by / Recommending Approval by / Approved by / Page x of y) at the bottom
  of every page. templates-render.js draws it when a template has
  layout: 'course-outline'.

  Runs on every server start, like seed-templates.js:
  - Additive only — never touches users, portfolios, sessions or settings.
  - Idempotent — nothing changes unless the data file's version changes.
  - Never overwrites a course template an IT Administrator edited by hand
    (manual edits set updatedBy).

  Content: data/coed-course-outlines-2026-2027.json (from the official
  READ100 COED course outline .docx). To add more COED courses, add them
  to that file's "courses" list and bump its "version".
*/
const path = require('path');

const SOURCE = 'coed-course-outline-2026-2027';
const DATA_FILE = path.join(__dirname, 'data', 'coed-course-outlines-2026-2027.json');
const TEMPLATE_CODE = 'COED-CO-V1';
const FORM_CODE = 'PNC:AA-FO-44 rev.0 06182026';

// The order of the official form. Generic section types, so the wizard's
// summaries keep working; the course-outline renderer draws them in the
// COED form's own layout.
const SECTIONS = [
  { key: 'orgProfile', type: 'staticOrgTable', label: 'Program Educational Objectives / Core Values / Graduate Attributes' },
  { key: 'programOutcomes', type: 'programOutcomes', label: 'Student Outcomes for the Program' },
  { key: 'courseInfo', type: 'keyvalueGrid', label: 'Course Code & Units / Title / Description / Schedule / Faculty', fields: [
    { key: 'courseCode', label: 'Course Code & Units' },
    { key: 'courseTitle', label: 'Course Title' },
    { key: 'description', label: 'Course Description', fullWidth: true },
    { key: 'facultySchedule', label: 'Schedule' }
  ] },
  { key: 'cilo', type: 'list', label: 'Course Intended Learning Outcomes (CILO)', source: 'outcomes' },
  { key: 'soMap', type: 'soMatrix', label: 'Student Outcomes Map Addressed by the Course', columns: ['I/L', 'E/P', 'D/O'] },
  { key: 'teachingPlan', type: 'weeklyPlanTable', label: 'Course Outline and Time-Frame', columns: ['Week', 'Topic'] },
  { key: 'references', type: 'referenceList', label: 'Textbook / Suggested Readings and References', groups: [
    { key: 'textbooks', label: 'Textbook' },
    { key: 'suggested', label: 'Suggested Readings and References' }
  ] },
  { key: 'courseRequirements', type: 'list', label: 'Course Requirements', source: 'courseRequirements' },
  { key: 'grading', type: 'gradingBreakdown', label: 'Grading System' },
  { key: 'classPolicies', type: 'classPolicies', label: 'Course Policies' },
  { key: 'approval', type: 'signatureBlock', label: 'Course Title / Prepared by / Reviewed by / Recommending Approval by / Approved by', roles: [
    { key: 'preparedBy', label: 'Prepared by', multiple: true },
    { key: 'reviewedBy', label: 'Reviewed by', multiple: false },
    { key: 'concurredBy', label: 'Recommending Approval by:', multiple: false },
    { key: 'approvedBy', label: 'Approved by', multiple: true }
  ] }
];

function applyCoedTemplates(db, data, store) {
  const now = store.nowIso();
  let changed = false;
  const log = (m) => console.log(`[seed-coed] ${m}`);

  if (!db.departments) db.departments = [];
  if (!db.programs) db.programs = [];
  if (!db.obtlpTemplates) db.obtlpTemplates = [];
  if (!db.courseTemplates) db.courseTemplates = [];
  if (!db.catalog) db.catalog = { courses: [], departments: [], academicYears: [] };
  if (!db.catalog.courses) db.catalog.courses = [];

  // --- department ----------------------------------------------------------
  const deptDef = data.department || { code: 'COED', name: 'College of Education' };
  let dept = db.departments.find((d) => String(d.code || '').toUpperCase() === deptDef.code);
  if (!dept) {
    dept = { id: store.nextId('dept'), code: deptDef.code, name: deptDef.name, createdAt: now };
    db.departments.push(dept); changed = true; log(`department ${deptDef.code} created`);
  }

  // --- program ---------------------------------------------------------------
  const progDef = data.program;
  let prog = db.programs.find((p) => String(p.code || '').toUpperCase() === progDef.code && p.departmentId === dept.id);
  if (!prog) {
    prog = {
      id: store.nextId('prog'), departmentId: dept.id, code: progDef.code, name: progDef.name,
      peo: progDef.peo.slice(), peoIntro: progDef.peoIntro, studentOutcomes: [], soSeedVersion: data.version, createdAt: now
    };
    db.programs.push(prog); changed = true; log(`program ${progDef.code} created`);
  }

  // --- the Course Outline form ---------------------------------------------
  let tpl = db.obtlpTemplates.find((t) => t.code === TEMPLATE_CODE);
  if (!tpl) {
    tpl = {
      id: store.nextId('tpl'), code: TEMPLATE_CODE, name: 'COED Course Outline (College of Education)',
      departmentId: dept.id, programId: '', version: '1',
      layout: 'course-outline', docTitle: 'COURSE OUTLINE',
      secondaryLogo: 'assets/coed-logo.png',
      formCode: FORM_CODE, effectivityText: '',
      active: true, sections: SECTIONS, createdAt: now, updatedAt: now
    };
    db.obtlpTemplates.push(tpl); changed = true; log(`template ${TEMPLATE_CODE} created`);
  } else if (!tpl.layout) {
    tpl.layout = 'course-outline'; tpl.updatedAt = now; changed = true;
  }

  // --- course templates --------------------------------------------------------
  let created = 0, refreshed = 0, kept = 0;
  (data.courses || []).forEach((c) => {
    const existing = db.courseTemplates.find((t) =>
      String(t.courseCode || '').toLowerCase() === String(c.courseCode).toLowerCase() && t.programId === prog.id);
    const content = {
      courseCode: c.courseCode,
      courseTitle: c.courseTitle,
      departmentId: dept.id,
      programId: prog.id,
      obtlpTemplateId: tpl.id,
      prerequisite: c.prerequisite || '',
      description: c.description || '',
      outcomes: c.outcomes || [],
      objectives: [],
      syllabus: '',
      teachingMaterials: [],
      references: [],
      soMap: c.soMap || [],
      teachingPlan: c.teachingPlan || [],
      referenceGroups: Object.assign({ textbooks: [], onlineResources: [], journals: [], suggested: [] }, c.referenceGroups || {}),
      grading: c.grading || { components: [] },
      courseRequirements: c.courseRequirements || [],
      classPoliciesOverride: '',
      effectivityText: '',
      officialMeta: c.officialMeta || {},
      source: SOURCE,
      seedVersion: data.version
    };
    if (!existing) {
      db.courseTemplates.push(Object.assign({ id: store.nextId('tpl') }, content, { updatedBy: null, createdAt: now, updatedAt: now }));
      created++; changed = true;
    } else if (existing.source === SOURCE && !existing.updatedBy && existing.seedVersion !== data.version) {
      Object.assign(existing, content, { updatedAt: now });
      refreshed++; changed = true;
    } else {
      kept++;
    }
    if (!db.catalog.courses.some((x) => String(x.code || '').toLowerCase() === String(c.courseCode).toLowerCase())) {
      db.catalog.courses.push({ code: c.courseCode, title: c.courseTitle }); changed = true;
    }
  });
  if (created || refreshed) log(`course outlines: ${created} created, ${refreshed} refreshed, ${kept} unchanged`);
  return changed;
}

async function ensureCoedTemplates(store) {
  let data;
  try {
    data = require(DATA_FILE);
  } catch (err) {
    console.error('[seed-coed] could not read data file — skipping:', err.message);
    return;
  }
  try {
    const db = await store.readDb();
    if (applyCoedTemplates(db, data, store)) await store.writeDb(db);
  } catch (err) {
    // Never block the server from starting because of seeding.
    console.error('[seed-coed] failed:', err && err.message ? err.message : err);
  }
}

module.exports = { ensureCoedTemplates, applyCoedTemplates };

if (require.main === module) {
  const store = require('./dbstore');
  store.initDbIfMissing().then(() => ensureCoedTemplates(store)).then(() => process.exit(0));
}
