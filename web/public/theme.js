// Applies the saved theme before first paint (a blocking external script, allowed by the CSP).
(function () {
  var t = null;
  try { t = localStorage.getItem('cx-theme'); } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
