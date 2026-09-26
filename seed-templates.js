/*
  Official BS CS / BS IT OBTLP templates, 1st Semester AY 2026-2027.

  Runs automatically on every server start (see the bottom of server.js),
  so pushing to GitHub -> Render redeploy is all it takes to put these
  templates into MongoDB Atlas. Can also be run by hand:
      node seed-templates.js

  SAFE BY DESIGN
  - Additive only: never touches users, portfolios, sessions, audit logs,
    notifications or settings.
  - Idempotent: running it again changes nothing unless the data file's
    version changed.
  - Never overwrites a course template an admin edited by hand in IT Admin
    (the server stamps `updatedBy` on every manual edit; seeded rows keep
    updatedBy = null). Newer seed data only refreshes rows that are still
    untouched.
  - Portfolios already created keep their own copy of the content (the
    wizard copies template data into the portfolio), so nothing a faculty
    member already prepared changes.

  Content source: data/obtlp-official-2026-2027.json, extracted from the
  official scanned PnC OBTLP PDFs.
*/
const path = require('path');

const SOURCE = 'official-2026-2027';
const DATA_FILE = path.join(__dirname, 'data', 'obtlp-official-2026-2027.json');

const LETTERHEAD = {
  line1: 'Republic of the Philippines',
  line2: 'Pamantasan ng Cabuyao',
  line3: '(University of Cabuyao)',
  line4: 'Academics and Student Services Division',
  address: 'Katapatan Mutual Homes, Brgy. Banay-banay, City of Cabuyao, Laguna 4025'
};

const DEFAULT_ORG = {
  letterhead: LETTERHEAD,
  vision: 'An institution of higher learning in Region IV, developing globally-competitive and value-laden professionals and leaders instrumental to community development and nation building.',
  mission: 'An institution of higher learning committed to equip individuals with knowledge, skills and values that will enable them to achieve professional goals & provide leadership and service for national development.',
  coreValuesIntro: 'As a God-fearing institution respecting multi-faith of people, PnC adheres to the following core values:',
  coreValues: ['Personal Dignity', 'Nurturing Community', 'Commitment to Excellence'],
  graduateAttributes: [
    'Professional competent individual', 'Proficient communicator', 'Analytical & problem solver',
    'Lifelong learner', 'Team leader or player', 'Productive individual',
    'Socially and ethically responsible citizen', 'Technology-driven professional', 'Value-laden professional'
  ],
  soIntensityLegend: [
    { code: 'I/L', label: 'Introductory/Learning' },
    { code: 'E/P', label: 'Enabling/Practice' },
    { code: 'D/O', label: 'Demonstrating/Opportunity' }
  ],
  attendanceRule: {
    note: 'Attendance will be considered as basis for dropping students. Below is the table showing the maximum number of absences against number of meetings per week.',
    columns: ['# of meetings per week', 'Absences should not exceed (per sem)'],
    rows: [['5', '17'], ['3', '10'], ['2', '7'], ['1', '3']]
  },
  classPolicies: {
    attendanceHeading: 'Class Attendance',
    attendanceText: 'As per CHED policy on attendance, a student who misses a maximum of 20% of the total contact hours will be given a grade of failure due to absences.',
    academicDishonestyHeading: 'Academic Dishonesty',
    academicDishonestyIntro: 'Academic Dishonesty is a deliberate attempt to misrepresent, fabricate or otherwise tamper with data, information, records, or any other material that is relevant to the student’s participation in any course, laboratory, or other academic exercise or function. These may include but may not be limited to:',
    academicDishonestyItems: [
      'Falsification, forgery, alteration, unauthorized possession, or misuse of school official documents, records, or identification, or knowingly furnishing false information to the university or to a university official.',
      'Unauthorized accessing of electronic information of the university and securing, soliciting, and holding a copy of an examination or a portion thereof, that is yet to be administered.',
      'Plagiarism or copyright infringement.'
    ],
    submissionHeading: 'Submission of Course Requirements',
    submissionText: 'Course requirements must be submitted on-time.'
  }
};

const EFFECTIVITY = 'The course OBTL shall have three academic year effectivity. Necessary revision may still be done on a case-to-case basis, especially when new competency requirements need to be satisfied but cannot be immediately addressed by the current course OBTL.';

const PROGRAMS = {
  BSCS: {
    code: 'BSCS',
    name: 'Bachelor of Science in Computer Science',
    peoIntro: 'Three to five years after graduation, the Bachelor of Science in Computer Science alumni shall:',
    peo: ['be employed in the field of computing;', 'possess globally competitive skills;', 'demonstrate personal dignity and integrity; and', 'engage in community development or nation building.']
  },
  BSIT: {
    code: 'BSIT',
    name: 'Bachelor of Science in Information Technology',
    peoIntro: 'Three to five years after graduation, the Bachelor of Science in Information Technology alumni shall:',
    peo: ['be employed in the field of computing;', 'possess globally competitive skills;', 'demonstrate personal dignity and integrity; and', 'engage in community development or nation building.']
  }
};

const TEMPLATE_SECTIONS = [
  { key: 'orgProfile', type: 'staticOrgTable', label: 'Vision / Mission / Core Values / Graduate Attributes' },
  { key: 'programOutcomes', type: 'programOutcomes', label: 'Program Educational Objectives & Course Intended Learning Outcomes' },
  { key: 'soMap', type: 'soMatrix', label: 'Student Outcomes Map Addressed by the Course', columns: ['I/L', 'E/P', 'D/O'] },
  { key: 'courseInfo', type: 'keyvalueGrid', label: 'Course Information', fields: [
    { key: 'courseCode', label: 'Course/Subject Code' },
    { key: 'courseTitle', label: 'Course/Subject Title' },
    { key: 'facultyUnits', label: 'Credit Units' },
    { key: 'prerequisite', label: 'Course/Subject Pre-requisite/Co-requisite' },
    { key: 'description', label: 'Course/Subject Description', fullWidth: true }
  ] },
  { key: 'teachingPlan', type: 'weeklyPlanTable', label: 'Teaching and Learning Plan',
    columns: ['Week', 'Topics', 'Intended Learning Outcomes (ILO)', 'Teaching and Learning Activities (TLA)', 'Instructional Material', 'Assessment Tasks (AT)'] },
  { key: 'references', type: 'referenceList', label: 'Textbooks and Reference Materials', groups: [
    { key: 'textbooks', label: 'Book References' },
    { key: 'onlineResources', label: 'Online Resources' },
    { key: 'journals', label: 'Journals / Researches' }
  ] },
  { key: 'grading', type: 'gradingBreakdown', label: 'Grading System' },
  { key: 'attendance', type: 'staticAttendanceTable', label: 'Attendance' },
  { key: 'courseRequirements', type: 'list', label: 'Course Requirements', source: 'courseRequirements' },
  { key: 'classPolicies', type: 'classPolicies', label: 'Class Policies' },
  { key: 'effectivity', type: 'richtext', label: 'Effectivity Period', source: 'templateEffectivity' },
  { key: 'approval', type: 'signatureBlock', label: 'Approval', roles: [
    { key: 'preparedBy', label: 'Prepared by:', multiple: true },
    { key: 'reviewedBy', label: 'Reviewed and Recommended by:', multiple: false },
    { key: 'concurredBy', label: 'Concurred by:', multiple: false },
    { key: 'approvedBy', label: 'Approved by:', multiple: true }
  ] }
];

function applyOfficialTemplates(db, data, store) {
  const now = store.nowIso();
  let changed = false;
  const log = (m) => console.log(`[seed-templates] ${m}`);

  // --- org profile (Vision/Mission/etc.) -------------------------------
  if (!db.orgProfile || !Array.isArray(db.orgProfile.coreValues) || !db.orgProfile.coreValues.length) {
    db.orgProfile = Object.assign({}, DEFAULT_ORG, db.orgProfile || {}, { letterhead: Object.assign({}, LETTERHEAD, (db.orgProfile || {}).letterhead || {}), updatedAt: now });
    changed = true; log('orgProfile created');
  }

  // --- department ---------------------------------------------------------
  if (!db.departments) db.departments = [];
  let dept = db.departments.find((d) => String(d.code || '').toUpperCase() === 'CCS');
  if (!dept) {
    dept = { id: store.nextId('dept'), code: 'CCS', name: 'College of Computing Studies', createdAt: now };
    db.departments.push(dept); changed = true; log('department CCS created');
  }

  // --- programs -----------------------------------------------------------
  if (!db.programs) db.programs = [];
  if (!db.courseTemplates) db.courseTemplates = [];
  const programIds = {};
  Object.keys(PROGRAMS).forEach((code) => {
    const def = PROGRAMS[code];
    const sos = (data.studentOutcomes && data.studentOutcomes[code]) || [];
    let prog = db.programs.find((p) => String(p.code || '').toUpperCase() === code);
    if (!prog) {
      prog = { id: store.nextId('prog'), departmentId: dept.id, code, name: def.name, peo: def.peo.slice(), peoIntro: def.peoIntro, studentOutcomes: sos, soSeedVersion: data.version, createdAt: now };
      db.programs.push(prog); changed = true; log(`program ${code} created`);
    } else if (prog.soSeedVersion !== data.version && sos.length) {
      // Before replacing the program's Student Outcome list, freeze the SO
      // wording onto any existing course template rows that relied on it,
      // so older templates (e.g. the first CCS101 seed) print exactly as before.
      db.courseTemplates.filter((t) => t.programId === prog.id).forEach((t) => {
        (t.soMap || []).forEach((row) => {
          if (!row.description) {
            const so = (prog.studentOutcomes || []).find((s) => s.code === row.soCode);
            if (so) row.description = so.description;
          }
        });
      });
      prog.studentOutcomes = sos;
      prog.soSeedVersion = data.version;
      if (!prog.peo || !prog.peo.length) prog.peo = def.peo.slice();
      if (!prog.peoIntro) prog.peoIntro = def.peoIntro;
      changed = true; log(`program ${code} student outcomes updated`);
    }
    programIds[code] = prog.id;
  });

  // --- OBTLP template (the official landscape form) -----------------------
  if (!db.obtlpTemplates) db.obtlpTemplates = [];
  let tpl = db.obtlpTemplates.find((t) => t.code === 'CCS-OBTLP-V1');
  if (!tpl) {
    tpl = {
      id: store.nextId('tpl'), code: 'CCS-OBTLP-V1', name: 'CCS OBTLP (College of Computing Studies)',
      departmentId: dept.id, programId: '', version: '1',
      formCode: 'PNC:AA-FO-06 rev.2 08182023', effectivityText: EFFECTIVITY,
      active: true, sections: TEMPLATE_SECTIONS, createdAt: now, updatedAt: now
    };
    db.obtlpTemplates.push(tpl); changed = true; log('OBTLP template CCS-OBTLP-V1 created');
  } else if (!tpl.formCode) {
    tpl.formCode = 'PNC:AA-FO-06 rev.2 08182023'; changed = true;
  }

  // --- course templates -----------------------------------------------------
  if (!db.catalog) db.catalog = { courses: [], departments: [], academicYears: [] };
  if (!db.catalog.courses) db.catalog.courses = [];
  let created = 0, refreshed = 0, kept = 0;
  (data.courses || []).forEach((c) => {
    const programId = programIds[c.program];
    const existing = db.courseTemplates.find((t) =>
      String(t.courseCode || '').toLowerCase() === String(c.courseCode).toLowerCase() && t.programId === programId);
    const content = {
      courseCode: c.courseCode,
      courseTitle: c.courseTitle,
      departmentId: dept.id,
      programId,
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
      referenceGroups: c.referenceGroups || { textbooks: [], onlineResources: [], journals: [] },
      grading: c.grading || { components: [] },
      courseRequirements: c.courseRequirements || [],
      classPoliciesOverride: '',
      effectivityText: EFFECTIVITY,
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
    const inCatalog = db.catalog.courses.some((x) => String(x.code || '').toLowerCase() === String(c.courseCode).toLowerCase());
    if (!inCatalog) { db.catalog.courses.push({ code: c.courseCode, title: c.courseTitle }); changed = true; }
  });
  if (created || refreshed) log(`course templates: ${created} created, ${refreshed} refreshed, ${kept} unchanged`);
  return changed;
}

async function ensureOfficialTemplates(store) {
  let data;
  try {
    data = require(DATA_FILE);
  } catch (err) {
    console.error('[seed-templates] could not read data file — skipping:', err.message);
    return;
  }
  try {
    const db = await store.readDb();
    if (applyOfficialTemplates(db, data, store)) await store.writeDb(db);
  } catch (err) {
    // Never block the server from starting because of seeding.
    console.error('[seed-templates] failed — server will start without the new templates:', err);
  }
}

module.exports = { ensureOfficialTemplates, applyOfficialTemplates };

if (require.main === module) {
  const store = require('./dbstore');
  ensureOfficialTemplates(store).then(() => { console.log('[seed-templates] done'); process.exit(0); });
}
