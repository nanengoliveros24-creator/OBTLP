/*
  Server-side persistence for the OBTLP demo app.
  Reads/writes db.json on disk so data survives restarts and is shared
  by every client (previously this was faked with per-browser localStorage).

  A tiny write-queue serializes writes so two near-simultaneous requests
  (e.g. faculty submit + admin approve) can't corrupt the file.
*/
const fs = require('fs');
const path = require('path');

// Allow tests (or ops) to point at an isolated file instead of the real
// db.json, without changing any normal `node server.js` behavior.
const DB_PATH = process.env.OBTLP_DB_PATH
  ? path.resolve(process.env.OBTLP_DB_PATH)
  : path.join(__dirname, 'db.json');

let writeChain = Promise.resolve();

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDb(db) {
  // Queue writes so concurrent requests don't stomp on each other.
  writeChain = writeChain.then(
    () => fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8')
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
    const db = readDb();
    const result = mutator(db); // may throw — nothing has been written yet if so
    await fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    return { db, result };
  });

  // Keep the queue healthy regardless of whether this request succeeded.
  writeChain = resultPromise.then(
    () => undefined,
    () => undefined
  );

  return resultPromise;
}

function nowIso() {
  return new Date().toISOString();
}

let idCounter = Date.now();
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

module.exports = { readDb, writeDb, transact, nowIso, nextId };