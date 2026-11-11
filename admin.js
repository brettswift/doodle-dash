'use strict';
const crypto = require('node:crypto');
const same = (a, b) => {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function authorized(req, token) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!token && !!m && same(m[1], token);
}
function adminPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crayon Breath stats</title><style>
:root{color-scheme:dark}body{font:16px system-ui;background:#151820;color:#edf1fa;max-width:1200px;margin:2rem auto;padding:0 1rem;line-height:1.5}
input,button{font:inherit;padding:.6rem;background:#262c3a;color:inherit;border:1px solid #7d8da8;border-radius:6px}button{cursor:pointer}h1{margin-bottom:0}h2{margin-top:2rem}p{color:#bbc7db}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:.6rem;text-align:left;border-bottom:1px solid #394254;white-space:nowrap}th{color:#b5c8e9}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#202633;padding:1rem}#err{color:#ffafa0}.cards{display:flex;gap:1rem;flex-wrap:wrap}.card{background:#202633;border-radius:8px;padding:1rem;min-width:140px}.card strong{display:block;font-size:1.7rem}label{display:block;margin-top:1rem}
</style><h1>Crayon Breath stats</h1><p>Private, first-party game and service analytics. Times use America/Edmonton.</p>
<form id="login"><label for="token">Existing backup admin token</label><input id="token" type="password" autocomplete="off" required><button>Load / refresh</button></form>
<p>Token stays in this page only. Never saved in browser storage or URL.</p><p id="err" role="alert"></p>
<button id="csv" hidden>Export names CSV</button><button id="opsCsv" hidden>Export service samples CSV</button><main id="out"></main>
<script src="/admin/dashboard.js" defer></script></html>`;
}
module.exports = { authorized, adminPage };