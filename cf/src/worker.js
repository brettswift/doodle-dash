// Public Worker: static assets with the same allowlist/headers as the Node host, health/version, and a thin router
// that sends WebSocket upgrades to a Room Durable Object (/ws?room=CODE) or to the Directory (/ws, admin and stats paths).
import { FILES, SEC } from '../../static-files.js';
export { Directory } from './directory.js';
export { Room } from './room.js';

const HUB_PATHS = new Set(['/stats', '/admin/analytics', '/admin/analytics.json', '/admin/drawings.json', '/admin/export', '/admin/import']);
const isHubPath = (p) => HUB_PATHS.has(p) || /^\/admin\/drawings\/[0-9a-f]{8}\.json$/.test(p);

// Client-supplied internal headers must never reach a Durable Object: strip every x-hub-*, then set the trusted values.
export function toHub(request, cf = request.cf) {
  const h = new Headers(request.headers);
  for (const k of [...h.keys()]) if (k.toLowerCase().startsWith('x-hub-')) h.delete(k);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) h.set('x-hub-ip', ip);
  if (cf && cf.country) h.set('x-hub-country', String(cf.country));
  if (cf && cf.regionCode) h.set('x-hub-region', String(cf.regionCode));
  return new Request(request, { headers: h });
}

const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('dir'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/ws' && request.headers.get('upgrade') === 'websocket') {
      const origin = request.headers.get('origin');
      if (origin) { let ok = false; try { ok = new URL(origin).host === url.host; } catch { /* bad origin */ } if (!ok) return new Response('Forbidden', { status: 403 }); }
      const room = url.searchParams.get('room');
      if (room !== null) {
        if (!/^[A-Za-z]{4}$/.test(room)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        return env.ROOM.get(env.ROOM.idFromName(room.toUpperCase())).fetch(toHub(request));
      }
      return directory(env).fetch(toHub(request));
    }
    if (path === '/version') return new Response(JSON.stringify({ sha: env.GIT_SHA || 'dev' }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (path === '/healthz') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    if (isHubPath(path)) return directory(env).fetch(toHub(request));
    const f = (request.method === 'GET' || request.method === 'HEAD') ? FILES[path] : null;
    if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const asset = await env.ASSETS.fetch(new Request(new URL('/' + f[0], url), { method: 'GET' }));
    if (!asset.ok) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers: { 'content-type': f[1], 'cache-control': 'no-cache', ...SEC } });
  },
};
