/*
  The university's colleges, so each one is available for course templates
  and for assigning College Administrators (who then only see their own
  college's portfolios). Runs on every server start; only ADDS a college
  whose code is missing — never renames or removes one, so an IT
  Administrator can correct a name in "Departments & OBTLP Templates" and
  it stays corrected.
*/
const COLLEGES = [
  { code: 'CCS', name: 'College of Computing Studies' },
  { code: 'COED', name: 'College of Education' },
  { code: 'CAS', name: 'College of Arts and Sciences' },
  { code: 'CHAS', name: 'College of Health and Allied Sciences' },
  { code: 'COE', name: 'College of Engineering' },
  { code: 'CBAA', name: 'College of Business Administration and Accountancy' }
];

function applyDepartments(db, store) {
  if (!db.departments) db.departments = [];
  const added = [];
  COLLEGES.forEach((c) => {
    if (!db.departments.some((d) => String(d.code || '').toUpperCase() === c.code)) {
      db.departments.push({ id: store.nextId('dept'), code: c.code, name: c.name, createdAt: store.nowIso() });
      added.push(c.code);
    }
  });
  return added;
}

async function ensureDepartments(store) {
  try {
    const db = await store.readDb();
    const added = applyDepartments(db, store);
    if (added.length) {
      await store.writeDb(db);
      console.log(`[seed-departments] added ${added.join(', ')}`);
    }
  } catch (err) {
    console.error('[seed-departments] failed:', err && err.message ? err.message : err);
  }
}

module.exports = { ensureDepartments, applyDepartments, COLLEGES };
