'use strict';
// Ntfy delivery is best effort. A timeout after request write is ambiguous, so delivery is at-least-once.
function endpoint(base, topic) {
  try {
    const url = new URL(base);
    if (!/^https?:$/.test(url.protocol) || !/^[A-Za-z0-9_-]{1,64}$/.test(topic || '')) return null;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${topic}`;
    return url;
  } catch { return null; }
}
function gameStartMessage({ mode, players, configuredRounds }) {
  return `${mode === 'public' ? 'automatic public lobby' : 'private lobby'} started: ${players} players, ${configuredRounds} rounds`;
}
function makeNotifier({ baseUrl, topic = 'crayon_breath', fetchImpl = globalThis.fetch, log = () => {}, enabled = true } = {}) {
  const url = enabled && endpoint(baseUrl, topic);
  const status = { sent: 0, failed: 0, lastSentAt: null, lastFailedAt: null, payload: 'aggregate-only' };
  async function sendGameStart(event) {
    if (!url) return false;
    const body = gameStartMessage(event);
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', 'title': 'Crayon Breath game started', tags: 'video_game' }, body, signal: controller.signal });
        if (response.ok) { status.sent++; status.lastSentAt = Date.now(); return true; }
        log('ntfy game-start delivery failed', response.status);
      } catch (error) { log('ntfy game-start delivery failed', error.name || 'error'); } finally { clearTimeout(timer); }
    }
    status.failed++; status.lastFailedAt = Date.now(); return false;
  }
  return { configured: !!url, status, sendGameStart };
}
module.exports = { makeNotifier, gameStartMessage };
