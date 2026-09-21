/*
  Phase 1 one-time seed: populates the new Department / Program / OBTLP
  Template / Org Profile data model from the actual CCS101 DOCX template
  (CCS101-OBTLP-Intro-to-Computing-IT.docx), and adds a matching
  courseTemplates entry so the wizard can auto-populate CCS101 portfolios.

  ADDITIVE ONLY: never touches existing users/portfolios/sessions/auditLogs/
  notifications/settings/catalog, and is idempotent (safe to re-run — it
  skips any collection that already has data instead of duplicating it).

  Run manually: node seed-ccs101.js
*/
const store = require('./dbstore');

// readDb()/writeDb() are async (file or MongoDB backend), so the whole
// script body runs inside this IIFE — everything below is unchanged.
(async () => {

const db = await store.readDb();

let changed = false;

// ---------------------------------------------------------------------
// Org-wide profile (Vision/Mission/Core Values/Graduate Attributes, the
// SO-intensity legend, the standard CHED attendance table, and the
// standard class-policy boilerplate) — shared by every future template,
// extracted verbatim from the DOCX letterhead/boilerplate sections.
// ---------------------------------------------------------------------
if (!db.orgProfile) {
  db.orgProfile = {
    letterhead: {
      line1: 'Republic of the Philippines',
      line2: 'Pamantasan ng Cabuyao',
      line3: '(University of Cabuyao)',
      line4: 'Academic Affairs Division',
      address: 'Katapatan Mutual Homes, Brgy. Banay-banay, City of Cabuyao, Laguna 4025'
    },
    vision: 'An institution of higher learning in Region IV, developing globally-competitive and value-laden professionals and leaders instrumental to community development and nation building.',
    mission: 'An institution of higher learning committed to equip individuals with knowledge, skills and values that will enable them to achieve professional goals & provide leadership and service for national development.',
    coreValuesIntro: 'As a God-fearing institution respecting multi-faith of people, PnC adheres to the following core values:',
    coreValues: ['Personal Dignity', 'Nurturing Community', 'Commitment to Excellence'],
    graduateAttributes: [
      'Professional competent individual',
      'Proficient communicator',
      'Analytical & problem solver',
      'Lifelong learner',
      'Team leader or player',
      'Productive individual',
      'Socially and ethically responsible citizen',
      'Technology-driven professional',
      'Value-laden professional'
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
      academicDishonestyIntro: 'Academic Dishonesty – is a deliberate attempt to misrepresent, fabricate or otherwise tamper with data, information, records, or any other material that is relevant to the student’s participation in any course, laboratory, or other academic exercise or function. These may include but may not be limited to:',
      academicDishonestyItems: [
        'Falsification, forgery, alteration, unauthorized possession, or misuse of school official documents, records, or identification, or knowingly furnishing false information to the university or to a university official.',
        'Unauthorized accessing of electronic information of the university and securing, soliciting, and holding a copy of an examination or a portion thereof, that is yet to be administered.',
        'Plagiarism or copyright infringement.'
      ],
      submissionHeading: 'Submission of Course Requirements',
      submissionText: 'Course requirements must be submitted on-time.'
    },
    updatedAt: store.nowIso()
  };
  changed = true;
  console.log('Seeded orgProfile.');
} else {
  console.log('orgProfile already exists — skipped.');
}

// ---------------------------------------------------------------------
// Department / Program
// The DOCX header prints "Department: Information Technology", but the
// existing sample portfolios in this system already use the department
// name "College of Computing Studies" (and the course code CCS101 itself
// carries the "CCS" prefix) — so this seed models:
//   Department = College of Computing Studies (the college/unit)
//   Program    = BS Information Technology (the program offered by it,
//                which the DOCX's PEO paragraph explicitly names)
// This mapping is an assumption — flagged for confirmation, not invented
// content (the PEO/SO/course text itself is verbatim from the DOCX).
// ---------------------------------------------------------------------
if (!db.departments) db.departments = [];
if (!db.programs) db.programs = [];

let dept = db.departments.find((d) => d.code === 'CCS');
if (!dept) {
  dept = { id: store.nextId('dept'), code: 'CCS', name: 'College of Computing Studies', createdAt: store.nowIso() };
  db.departments.push(dept);
  changed = true;
  console.log('Seeded department: College of Computing Studies (CCS).');
} else {
  console.log('Department CCS already exists — skipped.');
}

let program = db.programs.find((p) => p.code === 'BSIT');
if (!program) {
  program = {
    id: store.nextId('prog'),
    departmentId: dept.id,
    code: 'BSIT',
    name: 'Bachelor of Science in Information Technology',
    peo: [
      'be employed in the field of Information Technology;',
      'possess globally competitive skills;',
      'demonstrate personal dignity and integrity; and',
      'engage in community development or nation building.'
    ],
    peoIntro: 'Three to five years after graduation, the Bachelor of Science in Information Technology alumni shall:',
    studentOutcomes: [
      { code: 'SO3', description: 'Analyze complex problems, and identify and define the computing requirements appropriate to its solution' },
      { code: 'SO7', description: 'Apply knowledge through the use of current techniques, skills, tools and practices necessary for the IT profession.' },
      { code: 'SO10', description: 'Communicate effectively with the computing community and with society at large about complex computing activities through logical writing, presentations, and clear instructions' }
    ],
    createdAt: store.nowIso()
  };
  db.programs.push(program);
  changed = true;
  console.log('Seeded program: BS Information Technology (BSIT).');
} else {
  console.log('Program BSIT already exists — skipped.');
}

// ---------------------------------------------------------------------
// OBTLP Template — the data-driven blueprint. "sections" is the generic,
// extensible schema the renderer (HTML preview + PDF) walks; a future
// CHED/other-department template is just another row like this one.
// ---------------------------------------------------------------------
if (!db.obtlpTemplates) db.obtlpTemplates = [];

let template = db.obtlpTemplates.find((t) => t.code === 'CCS-OBTLP-V1');
if (!template) {
  template = {
    id: store.nextId('tpl'),
    code: 'CCS-OBTLP-V1',
    name: 'CCS OBTLP (College of Computing Studies)',
    departmentId: dept.id,
    programId: program.id,
    version: '1',
    formCode: 'PNC:AA-FO-06 rev.2 08182023',
    effectivityText: 'The course OBTL shall have three academic year effectivity. Necessary revision may still be done on a case-to-case basis, especially when new competency requirements need to be satisfied but cannot be immediately addressed by the current course OBTL.',
    active: true,
    sections: [
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
        { key: 'onlineResources', label: 'Online Resources' }
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
    ],
    createdAt: store.nowIso(),
    updatedAt: store.nowIso()
  };
  db.obtlpTemplates.push(template);
  changed = true;
  console.log('Seeded OBTLP template: CCS-OBTLP-V1.');
} else {
  console.log('Template CCS-OBTLP-V1 already exists — skipped.');
}

// ---------------------------------------------------------------------
// Course template content for CCS101 — verbatim from the DOCX. This is
// the reusable, IT/Admin-managed course-level content that auto-fills a
// faculty member's portfolio (existing non-destructive "fill only blank
// fields" behavior in portfolio-new.html applies to these too).
// ---------------------------------------------------------------------
if (!db.courseTemplates) db.courseTemplates = [];

let courseTpl = db.courseTemplates.find((t) => String(t.courseCode || '').toUpperCase() === 'CCS101');
if (!courseTpl) {
  courseTpl = {
    id: store.nextId('tpl'),
    courseCode: 'CCS101',
    courseTitle: 'Introduction to Computing',
    departmentId: dept.id,
    programId: program.id,
    obtlpTemplateId: template.id,
    prerequisite: 'none',
    description: 'This course provides an overview of the Computing Industry and Computing profession, including Research and Applications in different fields; an Appreciation of Computing in different fields such as Biology, Sociology, Environment and Gaming; an Understanding of ACM Requirements; an Appreciation of the History of computing; and Knowledge of the Key Components of Computer Systems (Organization and Architecture), Malware, Computer Security, Internet and Internet protocols, HTML 4/5 and CSS.',

    // Course Intended Learning Outcomes — reuses the existing "outcomes"
    // field name/UI (it already means "Intended Learning Outcomes" in the
    // wizard), so no new duplicate field was introduced for this.
    outcomes: [
      'Explain fundamentals principles, concepts, and evolution of computing systems as they relate to different fields',
      'Expound on the recent developments in the different computing knowledge areas.',
      'Analyze solutions employed by organization to address different computing issues'
    ],
    objectives: [],
    syllabus: '',
    teachingMaterials: [],

    // Student Outcomes this course addresses. Intensity (I/L / E/P / D/O)
    // was shown in the DOCX as a checkbox/shading mark per SO row that did
    // not survive plain-text extraction, so it is left blank/configurable
    // here rather than guessed — see Phase 1 report, open question.
    soMap: [
      { soCode: 'SO3', intensity: '' },
      { soCode: 'SO7', intensity: '' },
      { soCode: 'SO10', intensity: '' }
    ],

    teachingPlan: [
      { type: 'week', week: '1',
        topics: ['Discussion of PnC Mission and Vision, Program Outcomes, Course Outcomes', 'Course Orientation and Policies', 'OBE Orientation', 'Computer Concept', 'History of Computing', 'Types of Computers'],
        ilo: ['Explain fundamental concept and evolution of computer', 'Identify different types of computers and generations.'],
        tla: ['Faculty led discussion/Interaction'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory Exercises'] },
      { type: 'week', week: '2-3',
        topics: ['Lecture: Components of Computer Systems (Organization and Architecture)', 'Introduction to GUI based Operating System - Types of OS - Popular OS - User Interface', 'Laboratory: Application Software/Program (Microsoft Word)'],
        ilo: ['Describe at least five key components of Computer System', 'Differentiate types of Operating System', 'Describe at least two User Interface', 'Create and edit a document', 'Apply the different features (font, paragraph)'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'week', week: '4-5',
        topics: ['Lecture: Malware - Types of malwares - Prevention', 'Computer Security', 'Laboratory: Application Software/Program (Microsoft Word)'],
        ilo: ['Recognize different types of Malwares', 'Describe different types of attacks', 'Classify different types of Cyber Security', 'Create a screen design using the drawing toolbar', 'Arrange text and graphics'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'milestone', label: 'Prelim Examination' },
      { type: 'week', week: '7-8',
        topics: ['Lecture: Networks', 'Internet and Internet Protocols'],
        ilo: ['Explain What is network', 'Describe Computer Networks, Internet and Internet Protocols'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'week', week: '9-10',
        topics: ['Lecture: HTML 4/5 - Basic - Elements - Attributes', 'Laboratory: Application Software/Program (HTML 4/5)'],
        ilo: ['Demonstrate HTML 4/5 fundamentals', 'Insert a graphic within a web page', 'Create a link and table within a web page', 'Insert heading levels within a web page', 'Insert ordered and unordered lists within a web page.'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'week', week: '11',
        topics: ['Lecture: CSS Basics - Syntax - Selectors - How to', 'Laboratory: Application Software/Program (CSS)'],
        ilo: ['Demonstrate CSS fundamentals', 'Use cascading style sheet', 'Create a web page', 'Validate a web page', 'Publish a web page'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'milestone', label: 'Midterm Examination' },
      { type: 'week', week: '13-14',
        topics: ['Lecture: Overview of Computing Industry and Computing Profession (Research and Applications in different fields)', 'Laboratory: Application Software/Program (Microsoft Ppt)'],
        ilo: ['Explain research and application of Computing Industry and Computing Profession in different fields.', 'Create slide presentations that includes text, graphics, animation and transitions', 'Apply slide show presentation'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'week', week: '15-16',
        topics: ['Lecture: Computing in different fields (Biology, Sociology, Environment and Gaming)', 'Laboratory: Application Software/Program (Microsoft Ppt)'],
        ilo: ['Identify Computing in different fields (Biology, Sociology, Environment and Gaming)', 'Create slide presentations that includes text, graphics, animation and transitions', 'Apply slide show presentation'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises', 'Laboratory hands-on Exercises'] },
      { type: 'week', week: '17',
        topics: ['Lecture: (Association for Computing Machinery) ACM requirements', 'Laboratory: Application Software/Program (Microsoft Ppt)'],
        ilo: ['Distinguish ACM requirements', 'Create slide presentations that includes text, graphics, animation and transitions', 'Apply slide show presentation'],
        tla: ['Faculty led discussion/Interaction', 'Laboratory Demonstration'],
        instructionalMaterials: ['Module/Ppt/Video'],
        assessmentTasks: ['Module Exercises (Case Studies)', 'Laboratory hands-on Exercises'] },
      { type: 'milestone', label: 'Final Examination' }
    ],

    referenceGroups: {
      textbooks: [
        'Besueña, J. S. (2019) Introduction to Information Technology Computer Fundamentals. Unlimited Books',
        'Carey, P. (2019) New Perspectives on HTML, CSS and JavaScript. Cengage Publishing',
        'Maynard, P. (2020) Principles of Computer Science. Larsen and Keller Education',
        'Revano, T. F, (2019) Computer System Organization with Assembly. Mindshapers Co., Inc.',
        'Tayuan, Ronina R. C. (2019) Living in The Information Technology Era. C&E Publishing Inc.'
      ],
      onlineResources: [
        'W3Schools. (2022) HTML Tutorials. Retrieved August 8, 2023, from https://www.w3schools.com/html/html_intro.asp',
        'W3Schools. (2022) CSS Tutorials. Retrieved August 8, 2023, from https://www.w3schools.com/css/default.asp',
        'Javatpoint. (2021). MS Word Tutorial. Retrieved August 5, 2023, from https://www.javatpoint.com/ms-word-tutorial',
        'Javatpoint. (2021). MS Powerpoint Tutorial. Retrieved August 5, 2023, from https://www.javatpoint.com/ms-powerpoint-tutorial',
        'E-Journal Subscription (https://link.gale.com/apps/menu?u=phpnc)',
        'Electronic Journal of Computer Science and Information Technology (eJCSIT)',
        'Information Technology and Libraries',
        'Journal of Computer Science & Technology'
      ]
    },
    references: [],

    // Grading breakdown, verbatim from the DOCX tables (including the
    // "Grade Source" labels exactly as printed, even where they read
    // unusually — nothing here was invented or corrected).
    grading: {
      components: [
        {
          name: 'Lecture',
          weightPct: 60,
          weightNote: 'to be computed with Laboratory grade; 100% for purely lecture classes only',
          items: [
            { item: 'Quizzes', source: 'Laboratory Exercises', pct: 20 },
            { item: 'Class Participation', source: 'Recitation', pct: 10 },
            { item: 'Other Requirements', source: 'Research Project/Case Studies', pct: 20 },
            { item: 'Exam', source: 'Laboratory Examination', pct: 50 }
          ]
        },
        {
          name: 'Laboratory',
          weightPct: 40,
          weightNote: '',
          items: [
            { item: 'Quizzes', source: 'Laboratory Exercises', pct: 80 },
            { item: 'Exam', source: 'Laboratory Exam', pct: 20 }
          ]
        }
      ]
    },

    courseRequirements: ['Class Participation', 'Research Project/Case Study', 'Quiz', 'Exam', 'Portfolio'],
    classPoliciesOverride: '',
    effectivityText: 'The course OBTL shall have three academic year effectivity. Necessary revision may still be done on a case-to-case basis, especially when new competency requirements need to be satisfied but cannot be immediately addressed by the current course OBTL.',

    updatedBy: null,
    createdAt: store.nowIso(),
    updatedAt: store.nowIso()
  };
  db.courseTemplates.push(courseTpl);
  changed = true;
  console.log('Seeded course template: CCS101 — Introduction to Computing.');
} else {
  console.log('Course template CCS101 already exists — skipped.');
}

// Keep the existing free-text catalog in sync so the legacy course
// combobox (used when no department/program is selected) still lists
// CCS101 exactly as before.
if (!db.catalog) db.catalog = { courses: [], departments: [], academicYears: [] };
const catalogHasCourse = (db.catalog.courses || []).some((c) => String(c.code || '').toUpperCase() === 'CCS101');
if (!catalogHasCourse) {
  db.catalog.courses.push({ code: 'CCS101', title: 'Introduction to Computing' });
  changed = true;
  console.log('Added CCS101 to the legacy course catalog.');
}

if (changed) {
  await store.writeDb(db);
  console.log('db.json updated.');
} else {
  console.log('Nothing to do — db.json already fully seeded.');
}

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
