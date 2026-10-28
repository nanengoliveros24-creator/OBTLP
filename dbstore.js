/*
  Server-side persistence for the OBTLP app.

  Two backends, chosen automatically at startup based on env vars:

  - MongoDB Atlas (MONGODB_URI set) — production (Render). The whole
    db.json-shaped object is stored as ONE document (_id: "main") in a
    single collection ("obtlp_store" by default). Render's free tier has
    no persistent disk, so this is what makes data survive redeploys —
    the file-based backend below does not. The client connects once at
    module load and is reused for every request.
  - Local file (MONGODB_URI unset) — the original db.json-on-disk
    behavior. Used for local dev and the test suite (tests/helpers.js
    spawns server.js with OBTLP_DB_PATH pointed at a throwaway file and
    never sets MONGODB_URI, so tests keep working unchanged).

  Every exported function (readDb/writeDb/transact/initDbIfMissing) is
  async in both modes, so callers always `await` them regardless of which
  backend is active.

  A tiny write-queue serializes writes (in both modes) so two
  near-simultaneous requests (e.g. faculty submit + admin approve) can't
  corrupt the stored data.
*/
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGO_DB_NAME = process.env.MONGODB_DB_NAME || 'obtlp';
const MONGO_COLLECTION = 'obtlp_store';
const MONGO_DOC_ID = 'main';
const USING_MONGO = !!MONGODB_URI;

// Allow tests (or ops) to point at an isolated file instead of the real
// db.json, without changing any normal `node server.js` behavior. Only
// used when MONGODB_URI is not set.
const DB_PATH = process.env.OBTLP_DB_PATH
  ? path.resolve(process.env.OBTLP_DB_PATH)
  : path.join(__dirname, 'db.json');

function emptySchema() {
  // Minimal valid empty database (same top-level shape as the real
  // db.json) so the app stays usable — just with no existing
  // accounts/portfolios — instead of crashing every request.
  return {
    version: 2,
    users: [],
    portfolios: [],
    sessions: [],
    auditLogs: [],
    settings: {},
    notifications: [],
    catalog: { courses: [], departments: [], academicYears: [] },
    courseTemplates: [],
    orgProfile: {},
    departments: [],
    programs: [],
    obtlpTemplates: []
  };
}

// Render's free tier (file mode) or a brand-new Atlas cluster (Mongo mode)
// both start with no data. OBTLP_DB_SEED (set in Render's dashboard, never
// committed to git — it contains real accounts/password hashes) lets the
// first boot restore the real dataset instead of starting empty.
function seedOrEmpty() {
  const seed = process.env.OBTLP_DB_SEED;
  if (seed) {
    try {
      return { db: JSON.parse(seed), usedSeed: true };
    } catch (err) {
      console.error('[db] OBTLP_DB_SEED was not valid JSON, falling back to empty db:', err.message);
    }
  }
  return { db: emptySchema(), usedSeed: false };
}

let writeChain = Promise.resolve();

// ---------------------------------------------------------------------
// File-based backend (local dev / tests)
// ---------------------------------------------------------------------
function fileInitDbIfMissing() {
  if (fs.existsSync(DB_PATH)) return;
  const { db, usedSeed } = seedOrEmpty();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(usedSeed
    ? '[db] Initialized db.json from OBTLP_DB_SEED env var.'
    : '[db] No OBTLP_DB_SEED set — started a fresh empty db.json.');
}

function fileReadDb() {
  fileInitDbIfMissing();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function fileWriteDb(db) {
  return fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// ---------------------------------------------------------------------
// MongoDB backend (production / Render)
// ---------------------------------------------------------------------
let mongoClientPromise = null;

// Connects once and reuses the same client for every request (the driver
// manages its own internal connection pool), rather than reconnecting
// per call.
function getMongoCollection(name) {
  if (!mongoClientPromise) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    mongoClientPromise = client.connect().then(() => client);
  }
  return mongoClientPromise.then((client) => client.db(MONGO_DB_NAME).collection(name || MONGO_COLLECTION));
}

async function mongoInitDbIfMissing() {
  const col = await getMongoCollection();
  const existing = await col.findOne({ _id: MONGO_DOC_ID });
  if (existing) return;

  const { db, usedSeed } = seedOrEmpty();
  await col.insertOne(Object.assign({ _id: MONGO_DOC_ID }, db));
  console.log(usedSeed
    ? '[db] Initialized MongoDB store from OBTLP_DB_SEED env var.'
    : '[db] No OBTLP_DB_SEED set — started a fresh empty MongoDB store.');
}

async function mongoReadDb() {
  const col = await getMongoCollection();
  let doc = await col.findOne({ _id: MONGO_DOC_ID });
  if (!doc) {
    await mongoInitDbIfMissing();
    doc = await col.findOne({ _id: MONGO_DOC_ID });
  }
  const { _id, ...rest } = doc;
  return rest;
}

async function mongoWriteDb(db) {
  const col = await getMongoCollection();
  await col.replaceOne({ _id: MONGO_DOC_ID }, Object.assign({ _id: MONGO_DOC_ID }, db), { upsert: true });
}

// ---------------------------------------------------------------------
// Public API — dispatches to whichever backend is active
// ---------------------------------------------------------------------

async function initDbIfMissing() {
  return USING_MONGO ? mongoInitDbIfMissing() : fileInitDbIfMissing();
}

async function readDb() {
  return USING_MONGO ? mongoReadDb() : fileReadDb();
}

function writeDb(db) {
  // Queue writes so concurrent requests don't stomp on each other.
  writeChain = writeChain.then(
    () => (USING_MONGO ? mongoWriteDb(db) : fileWriteDb(db))
  );
  return writeChain;
}

// Run `mutator(db)` with exclusive access, persist the result, return it.
// `mutator` may return a value to hand back to the caller (e.g. the
// portfolio that was just changed) separate from the whole db.
//
// IMPORTANT: `writeChain` is the serialization queue used to order writes.
// If a request's mutator throws (e.g. "already submitted"), the promise we
// hand back to *that* caller must reject — but the shared queue itself must
// keep moving so the *next* request isn't stuck behind a rejected promise
// forever (a plain `.then()` chain would otherwise "poison" every future
// call once one link rejects, since `.then(onFulfilled)` with no rejection
// handler just re-throws instead of continuing).
function transact(mutator) {
  const resultPromise = writeChain.then(async () => {
    const db = await readDb();
    const result = mutator(db); // may throw — nothing has been written yet if so
    await (USING_MONGO ? mongoWriteDb(db) : fileWriteDb(db));
    return { db, result };
  });

  // Keep the queue healthy regardless of whether this request succeeded.
  writeChain = resultPromise.then(
    () => undefined,
    () => undefined
  );

  return resultPromise;
}

// ---------------------------------------------------------------------
// Stored files (e.g. an OBTLP template's own document), kept out of the
// main document. In Mongo mode each file is its own document in
// "obtlp_files", so it survives redeploys like the rest of the data
// (Render's disk does not); in file mode it sits in the uploads folder.
// ---------------------------------------------------------------------
const MONGO_FILES_COLLECTION = 'obtlp_files';
const FILES_DIR = process.env.OBTLP_UPLOADS_DIR
  ? path.resolve(process.env.OBTLP_UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
const storedFilePath = (id) => path.join(FILES_DIR, `file__${String(id).replace(/[^\w-]/g, '')}`);

async function putFile(id, buffer) {
  if (USING_MONGO) {
    const col = await getMongoCollection(MONGO_FILES_COLLECTION);
    await col.replaceOne({ _id: id }, { _id: id, data: buffer, size: buffer.length }, { upsert: true });
    return;
  }
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  await fs.promises.writeFile(storedFilePath(id), buffer);
}

// Resolves to a Buffer, or null when there is no such file.
async function getFile(id) {
  if (USING_MONGO) {
    const col = await getMongoCollection(MONGO_FILES_COLLECTION);
    const doc = await col.findOne({ _id: id });
    return doc ? Buffer.from(doc.data.buffer.subarray(0, doc.data.position)) : null;
  }
  try {
    return await fs.promises.readFile(storedFilePath(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function deleteFile(id) {
  if (USING_MONGO) {
    const col = await getMongoCollection(MONGO_FILES_COLLECTION);
    await col.deleteOne({ _id: id });
    return;
  }
  try {
    await fs.promises.unlink(storedFilePath(id));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

let idCounter = Date.now();
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

module.exports = { readDb, writeDb, transact, nowIso, nextId, initDbIfMissing, putFile, getFile, deleteFile };
