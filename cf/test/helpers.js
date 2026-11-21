import { SELF } from 'cloudflare:test';

export const BASE = 'https://crayon.test';
export const TOKEN = 'test-admin-token';
export const bearer = { authorization: 'Bearer ' + TOKEN };
export const get = (p, init) => SELF.fetch(BASE + p, init);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal WebSocket test client with the same behaviour as the browser and tools/qa-game.js: a {t:'goto'} message from
// the Directory closes the entry socket and re-opens /ws?room=CODE, then sends the given message verbatim.
export async function client(headers = {}) {
  const c = { status: 0, msgs: [], closed: null, waiters: [], ws: null, gotos: 0 };
  async function open(path) {
    const res = await SELF.fetch(BASE + path, { headers: { Upgrade: 'websocket', Origin: BASE, ...headers } });
    c.status = res.status;
    if (res.status !== 101) return false;
    const ws = res.webSocket; ws.accept(); c.ws = ws; c.closed = null;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'goto') { c.gotos++; ws.close(1000, 'goto'); c.ws.__gone = true; open('/ws?room=' + m.code).then(() => c.ws.send(JSON.stringify(m.msg))); return; }
      c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w(m));
    });
    ws.addEventListener('close', (e) => { if (ws !== c.ws) return; c.closed = e.code; c.waiters = c.waiters.filter((w) => !w(null)); });
    return true;
  }
  if (!(await open('/ws'))) return { status: c.status };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 6000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout; saw ' + JSON.stringify(c.msgs.slice(-3)))), ms);
    const hit = (m) => { if (m && pred(m)) { clearTimeout(t); resolve(m); return true; } return false; };
    for (const m of c.msgs) if (hit(m)) return;
    c.waiters.push(hit);
  });
  return c;
}
export const stubOf = (ns, name) => ns.get(ns.idFromName(name));
