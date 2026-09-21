# OBTLP System — Production Readiness Changelog

This pass fixed real, verified bugs in the existing system rather than
rewriting it from scratch. Everything below was tested end-to-end
(curl-driven auth/RBAC/ownership tests, plus manual page loads).

## Fixed: Login was bypassable
- `db.js` had a hardcoded `DEFAULT_SESSION` (a seeded "Juan Dela Cruz"
  faculty account) that logged in any visitor with no session at all.
  Removed. There is no default/fallback session anywhere now.
- Login is now backed by real server-side sessions (`auth.js` + a
  `sessions` table in `db.json`), issued as a bearer token on
  `/api/login`, sent as `Authorization: Bearer <token>` on every
  subsequent request, and checked server-side on every protected route.
- Removed the "Demo quick access" buttons from the sign-in page.

## Added: real registration
- `register.html` — new public faculty self-registration page
  (Full Name, Email/Username, Password, Confirm Password), linked from
  the sign-in page ("Create an Account").
- First-run "Setup" screen (shown only when zero accounts exist) creates
  the first Administrator or IT Administrator account; after that,
  `/api/setup` is permanently locked (403).
- Duplicate usernames, password mismatches, and short passwords are all
  rejected with clear messages.
- Passwords are hashed with `crypto.scrypt` (see `auth.js`) — nothing is
  stored in plain text.

## Removed: sample/demo data
- `db.json` reset to zero users, zero portfolios, zero notifications,
  zero audit logs. `settings` (school name/address) kept, since that's
  real configuration, not sample content.
- Deleted the leftover ad-hoc debug scripts (`verify_*.js`,
  `_login_test*.js`, `_full_test.js`) that weren't part of the app.

## Rebuilt: Create/Edit Portfolio
- `portfolio-new.html` is now a real 4-step wizard (Course Information →
  Upload Documents → Preview → Submit), matching the required workflow.
  Data persists across steps (saved to the server before advancing) and
  survives a page refresh.
- Every field is a real input, not `contentEditable` text: course code,
  title, semester, academic year, description, faculty
  department/units/schedule, objectives, intended learning outcomes,
  syllabus summary, teaching materials, references.
- Editing loads the saved portfolio and populates every field; a
  submitted/approved portfolio becomes read-only automatically.

## Added: real document uploads
- Upload endpoint stores files on disk (`uploads/`), validates type
  (PDF/DOCX/PPTX only) and size (15MB max), and records metadata
  (name/type/size) on the portfolio.
- Remove and re-upload both work. Downloads are auth-checked and stream
  the real file (owner or reviewing admin/IT only).

## Security / RBAC (server-enforced, not just hidden in the UI)
- Every API call resolves the caller's identity from their session
  token — nothing trusts a client-supplied user id or role anymore.
- A faculty member can only view/edit/delete their own portfolios and
  documents. Verified: a second faculty account gets 403 on another
  user's portfolio and cannot see it in their own portfolio list.
- Only `admin` accounts can approve/request revision. Only `it` accounts
  can manage user accounts, change settings, or run backups. Verified
  with 403s in both directions.
- Editing/uploading is blocked server-side once a portfolio leaves
  Draft/Revision Required (not just disabled in the UI).

## IT Administrator page
- "User Accounts" is now a real management screen (create, delete,
  reset password) wired to the existing user API.
- "Settings" is a real form for system/school name and address.
- Removed the fake hardcoded "Database Stores" percentages.
- "Run Backup" now actually writes a timestamped copy of `db.json` to
  `backups/`.

## Admin (review) page
- Compliance checklist reflects the real selected portfolio (course
  info complete, documents attached, objectives/outcomes present)
  instead of four hardcoded checkmarks.
- Added a "View Full Portfolio" link into the real preview page.
- Removed the "Reports" nav item (mocked, not a stated requirement).

## Other cleanups
- "Download PDF" now triggers the browser's real print-to-PDF against a
  dedicated print stylesheet, instead of a toast that did nothing.
- Sign out calls `/api/logout` (invalidates the session server-side)
  before clearing the local session.
- Error responses are plain, non-technical messages
  ("Incorrect username or password.", "This portfolio is Approved and
  can no longer be edited.") — no raw stack traces or DB errors reach
  the browser.
