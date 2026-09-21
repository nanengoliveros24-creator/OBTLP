/*
  Shared dark/light mode toggle.
  Pairs with the anti-flash inline snippet in each page's <head>, which
  sets data-theme="dark" on <html> BEFORE first paint if that was the last
  saved choice (avoiding a flash of the light theme on load).
  This file wires up the visible toggle control once the DOM is ready:
  looks for a #theme-toggle button, updates its sun/moon icon, and
  persists the choice to localStorage so it carries across every page.
*/
(function () {
  var KEY = 'obtlp-theme';

  function applyIcons(theme) {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var moon = btn.querySelector('.theme-icon-moon');
    var sun = btn.querySelector('.theme-icon-sun');
    if (moon) moon.style.display = theme === 'dark' ? 'none' : 'block';
    if (sun) sun.style.display = theme === 'dark' ? 'block' : 'none';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    applyIcons(theme);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var saved = localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    applyTheme(saved); // reconcile icon state; attribute was likely already set pre-paint

    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      applyTheme(next);
    });
  });
})();
