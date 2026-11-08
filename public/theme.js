// Theme bootstrap: runs in <head> before first paint. Dark unless the player picked light.
// The CSP forbids inline scripts, so this is a tiny blocking file. See docs/style-system.md.
(function () {
  var KEY = 'doodle-dash.theme';
  var META = { dark: '#2a2420', light: '#f7f0df' };
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', META[t]);
  }
  var t = 'dark';
  try { var s = localStorage.getItem(KEY); if (s === 'light' || s === 'dark') t = s; } catch (e) {}
  apply(t);
  window.__theme = {
    get: function () { return document.documentElement.getAttribute('data-theme'); },
    set: function (v) { apply(v); try { localStorage.setItem(KEY, v); } catch (e) {} },
  };
})();
