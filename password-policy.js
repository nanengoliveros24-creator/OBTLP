/*
  Password rules — shared by the server (require('./password-policy')) and
  the browser (<script src="password-policy.js"> → window.PasswordPolicy),
  so the sign-up form and the API always agree.

  A strong password has:
    - at least 8 characters (at most 128)
    - an uppercase letter (A-Z)
    - a lowercase letter (a-z)
    - a number (0-9)
    - a special character (anything that isn't a letter, number or space,
      e.g. ! @ # $ % ^ & * . _ -)
*/
(function (root) {
  const MIN_LENGTH = 8;
  const MAX_LENGTH = 128;
  const SPECIALS = '!@#$%^&*._-?';

  const RULES = [
    { key: 'length', label: `At least ${MIN_LENGTH} characters`, test: (p) => p.length >= MIN_LENGTH },
    { key: 'upper', label: 'An uppercase letter (A-Z)', test: (p) => /[A-Z]/.test(p) },
    { key: 'lower', label: 'A lowercase letter (a-z)', test: (p) => /[a-z]/.test(p) },
    { key: 'number', label: 'A number (0-9)', test: (p) => /[0-9]/.test(p) },
    { key: 'special', label: 'A special character (e.g. ! @ # $ % *)', test: (p) => /[^A-Za-z0-9\s]/.test(p) }
  ];

  // [{ key, label, ok }] for each rule — used for the live checklist.
  function check(password) {
    const p = String(password || '');
    return RULES.map((r) => ({ key: r.key, label: r.label, ok: r.test(p) }));
  }

  function isStrong(password) {
    const p = String(password || '');
    return p.length <= MAX_LENGTH && check(p).every((r) => r.ok);
  }

  // One sentence describing what is missing, or '' when the password is fine.
  function problem(password) {
    const p = String(password || '');
    if (p.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
    const missing = check(p).filter((r) => !r.ok);
    if (!missing.length) return '';
    return 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character (e.g. ! @ # $ %).';
  }

  // A random password that always passes the rules (used when an IT
  // Administrator leaves "Temporary Password" blank). randomInt(n) must
  // return an integer in [0, n).
  function generate(randomInt, length) {
    const len = Math.max(MIN_LENGTH, length || 12);
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', SPECIALS];
    const all = sets.join('');
    const chars = sets.map((s) => s[randomInt(s.length)]);
    while (chars.length < len) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    return chars.join('');
  }

  // Browser helper: a live checklist under a password input.
  // attachChecklist(inputEl) inserts <ul class="pw-rules"> after the input.
  function attachChecklist(input) {
    if (!input || typeof document === 'undefined') return null;
    const list = document.createElement('ul');
    list.className = 'pw-rules';
    list.setAttribute('aria-live', 'polite');
    const render = () => {
      list.innerHTML = '';
      check(input.value).forEach((r) => {
        const li = document.createElement('li');
        li.className = r.ok ? 'ok' : '';
        li.textContent = (r.ok ? '✓ ' : '• ') + r.label;
        list.appendChild(li);
      });
    };
    input.addEventListener('input', render);
    const anchor = (input.closest && input.closest('.input-with-icon')) || input;
    anchor.insertAdjacentElement('afterend', list);
    render();
    return { render };
  }

  const api = { MIN_LENGTH, MAX_LENGTH, RULES, check, isStrong, problem, generate, attachChecklist };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PasswordPolicy = api;
})(typeof window !== 'undefined' ? window : this);
