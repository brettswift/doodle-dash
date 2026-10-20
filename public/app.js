(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const COLORS = ['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524'];
const SIZES = [4, 10, 22];
const KEY = 'doodle-dash-session';
const NAMEKEY = 'doodle-dash-name';

let ws = null, sess = null, st = null, recvAt = 0, retry = 0, wantOpen = false, pendingEnter = null;
let strokes = [], tool = { c: COLORS[0], w: SIZES[1], eraser: false };
const G = window.DDGeom;
const cv = $('cv'), ctx = cv.getContext('2d');
ctx.lineCap = 'round'; ctx.lineJoin = 'round';

try { sess = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { sess = null; }
const saveSess = () => { try { sess ? localStorage.setItem(KEY, JSON.stringify(sess)) : localStorage.removeItem(KEY); } catch {} };

// ---------- connection ----------
function connect() {
  wantOpen = true;
  if (ws && ws.readyState <= 1) return;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(url);
  const mine = ws;
  ws.onopen = () => {
    retry = 0; $('banner').hidden = true;
    const first = pendingEnter || (sess && { t: 'resume', code: sess.code, token: sess.token });
    pendingEnter = null;
    if (first) send(first);
  };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
  ws.onclose = () => {
    if (mine !== ws) return;
    if (wantOpen && sess) { $('banner').hidden = false; setTimeout(connect, Math.min(5000, 400 * 2 ** retry++)); }
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && wantOpen && sess && (!ws || ws.readyState > 1)) connect(); });

function onMsg(m) {
  switch (m.t) {
    case 'joined':
      sess = { code: m.code, token: m.token }; saveSess(); break;
    case 'state': onState(m); break;
    case 'draw': remoteDraw(m); break;
    case 'clear': strokes = []; paintAll(); break;
    case 'chat': if (st) { st.chat.push(m.m); renderChat(); } break;
    case 'error': onError(m.msg); break;
  }
}
function onError(msg) {
  if (!st) {
    if (/session|No such room/i.test(msg) && sess) { sess = null; saveSess(); }
    $('homeErr').textContent = msg; show('home'); wantOpen = false; if (ws) ws.close();
  } else if (st.phase === 'lobby') $('lobbyErr').textContent = msg;
  else $('gameErr').textContent = msg;
}

// ---------- views ----------
function show(v) { for (const s of ['home', 'lobby', 'game']) $(s).hidden = s !== v; }
function onState(m) {
  const prev = st;
  if (m.strokes) strokes = m.strokes; else if (prev) m.strokes = strokes;
  st = m; recvAt = Date.now();
  $('homeErr').textContent = ''; $('lobbyErr').textContent = ''; $('gameErr').textContent = '';
  if (m.phase === 'lobby') { show('lobby'); renderLobby(); return; }
  show('game'); renderGame(prev);
  if (m.strokes !== undefined && (!prev || prev.phase !== m.phase || prev.drawerId !== m.drawerId || prev.phase === 'lobby' || m.phase === 'choosing')) paintAll();
  else if (!prev) paintAll();
}
const me = () => st.players.find((p) => p.id === st.you);
const isDrawer = () => st.you === st.drawerId;
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const k of kids) e.append(k);
  return e;
}

const DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const fmtMult = (m) => '×' + m;
const pts = (base, m) => Math.round(base * m);
const turnText = () => `Round ${st.rotation}/${st.rotations} · Turn ${st.rotTurn}/${st.rotTurns}`;
const rsel = $('rounds');
for (let i = 1; i <= 10; i++) rsel.append(el('option', { value: i, textContent: i + (i === 1 ? ' round' : ' rounds') }));
rsel.onchange = () => send({ t: 'rounds', n: +rsel.value });

function renderLobby() {
  $('lobbyCode').textContent = st.code;
  const ul = $('lobbyPlayers'); ul.replaceChildren();
  for (const p of st.players) ul.append(el('li', { className: p.connected ? '' : 'off', textContent: p.name + (p.id === st.hostId ? ' ★' : '') }));
  const host = st.you === st.hostId;
  rsel.disabled = !host; rsel.value = st.rotations;
  $('roundsHelp').textContent = `A round = every player draws once (${st.players.length} turn${st.players.length === 1 ? '' : 's'} now). ${st.rotations} round${st.rotations === 1 ? '' : 's'} = ${st.rotations * st.players.length} turns. ${host ? '' : 'Only the host changes this.'}`;
  $('start').hidden = !host;
  $('start').disabled = st.players.filter((p) => p.connected).length < 2;
  $('lobbyHint').textContent = host
    ? (st.players.length < 2 ? 'Share the code. Need at least 2 players.' : `${st.players.length} in the room. Start when ready.`)
    : 'Waiting for the host to start…';
}

function renderGame() {
  const drawer = st.players.find((p) => p.id === st.drawerId);
  $('roundInfo').textContent = st.phase === 'gameOver' ? 'Final' : `${turnText()}`;
  const hint = $('hint');
  if (st.word && (isDrawer() || st.phase !== 'drawing')) hint.textContent = st.word.toUpperCase();
  else if (st.phase === 'drawing' && st.len) hint.textContent = (st.lens || [st.len]).map((n) => Array(n).fill('_').join(' ')).join('   ');
  else hint.textContent = '';
  $('tools').hidden = !(st.phase === 'drawing' && isDrawer());
  const g = $('guessForm');
  g.hidden = st.phase === 'gameOver' || isDrawer();
  const can = st.phase === 'drawing' && !isDrawer() && !me().guessed;
  $('guess').disabled = !can; g.querySelector('button').disabled = !can;
  $('guess').placeholder = isDrawer() ? 'You are drawing!' : me().guessed ? 'You got it!' : 'Type your guess';
  const b = $('board'); b.replaceChildren();
  for (const p of [...st.players].sort((a, z) => z.score - a.score)) {
    const tag = (p.id === st.drawerId && st.phase !== 'gameOver' ? '✏️ ' : '') + (p.guessed ? '✅ ' : '');
    b.append(el('li', { className: (p.connected ? '' : 'off ') + (p.id === st.you ? 'me' : '') }, el('span', { textContent: tag + p.name }), el('b', { textContent: p.score })));
  }
  renderChat(); renderOverlay(drawer);
}
function renderChat() {
  const c = $('chat'); const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
  c.replaceChildren(...st.chat.map((m) => el('p', { className: m.k }, m.k === 'chat' ? el('b', { textContent: m.name + ': ' }) : '', m.text)));
  if (stick) c.scrollTop = c.scrollHeight;
}
function renderOverlay(drawer) {
  const o = $('overlay'); o.replaceChildren(); o.hidden = false;
  if (st.phase === 'choosing') {
    if (isDrawer()) {
      o.append(el('h2', { textContent: 'Pick a word to draw' }));
      const w = el('div', { className: 'words' });
      (st.choices || []).forEach((c, i) => w.append(el('button', { className: 'pick ' + c.diff, onclick: () => send({ t: 'pick', i }) },
        el('span', { className: 'w', textContent: c.word }),
        el('span', { className: 'd', textContent: `${DIFF_LABEL[c.diff]} ${fmtMult(c.mult)}` }),
        el('span', { className: 'p', textContent: `guess ${pts(50, c.mult)}–${pts(200, c.mult)} · you ${pts(25, c.mult)}/guess` }))));
      o.append(w);
    } else o.append(el('h2', { textContent: `${drawer.name} is choosing a word…` }));
  } else if (st.phase === 'roundEnd' || st.phase === 'gameOver') {
    const over = st.phase === 'gameOver';
    o.append(el('h2', { textContent: over ? 'Game over' : st.word ? `It was “${st.word}”` : 'Round skipped' }));
    if (!over) o.append(el('p', { className: 'sub small', textContent: `${turnText()} · ${drawer ? drawer.name : '?'} drew${st.diff ? ` · ${DIFF_LABEL[st.diff]} ${fmtMult(st.mult)}` : ''}` }));
    else o.append(el('p', { className: 'sub small', textContent: `${st.rotations} round${st.rotations === 1 ? '' : 's'} · ${st.turn} turns played` }));
    const ol = el('ol');
    [...st.players].sort((a, z) => z.score - a.score).forEach((p, i) =>
      ol.append(el('li', {}, el('span', { textContent: `${over ? i + 1 + '. ' : ''}${p.name}` }), el('b', { textContent: p.score + (!over && p.gain ? ` (+${p.gain})` : '') }))));
    o.append(ol);
    if (over) {
      if (st.you === st.hostId) o.append(el('button', { className: 'primary', textContent: 'Play again', onclick: () => send({ t: 'again' }) }));
      else o.append(el('p', { className: 'sub', textContent: 'Waiting for host…' }));
      o.append(el('button', { className: 'link', textContent: 'Leave', onclick: leave }));
    }
  } else o.hidden = true;
}

// timer
setInterval(() => {
  if (!st || st.phase === 'lobby') return;
  const left = Math.max(0, st.remaining - (Date.now() - recvAt));
  const total = st.phase === 'choosing' ? 15000 : st.phase === 'drawing' ? 80000 : 6000;
  const active = st.phase === 'choosing' || st.phase === 'drawing';
  $('timer').textContent = active ? Math.ceil(left / 1000) : '–';
  $('barFill').style.width = active ? Math.min(100, left / (st.total || total) * 100) + '%' : '0';
}, 250);

// ---------- canvas ----------
function seg(a, b, c, w) {
  const k = G.lineScale(cv.width), A = G.toPixel(a, cv.width, cv.height);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = w * k;
  if (!b) { ctx.beginPath(); ctx.arc(A[0], A[1], w * k / 2, 0, 7); ctx.fill(); return; }
  const B = G.toPixel(b, cv.width, cv.height);
  ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
}
function paintStroke(s) {
  const p = s.p;
  if (p.length === 2) return seg([p[0], p[1]], null, s.c, s.w);
  for (let i = 2; i < p.length; i += 2) seg([p[i - 2], p[i - 1]], [p[i], p[i + 1]], s.c, s.w);
}
function paintAll() {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const s of strokes) paintStroke(s);
}
function remoteDraw(m) {
  if (m.s) { const s = { c: m.c, w: m.w, p: [...m.p] }; strokes.push(s); paintStroke(s); return; }
  const s = strokes[strokes.length - 1]; if (!s) return;
  const n = s.p.length;
  const start = n >= 2 ? [s.p[n - 2], s.p[n - 1]] : null;
  s.p.push(...m.p);
  let prev = start;
  for (let i = 0; i < m.p.length; i += 2) { const q = [m.p[i], m.p[i + 1]]; seg(prev || q, prev ? q : null, s.c, s.w); prev = q; }
}

let drawing = null, buf = [], flushT = 0;
function pos(e) {
  return G.toNorm(e.clientX, e.clientY, cv.getBoundingClientRect());
}
const curColor = () => (tool.eraser ? '#ffffff' : tool.c);
function flush() {
  flushT = 0;
  while (buf.length) { const chunk = buf.splice(0, 80); send({ t: 'draw', s: drawing.first, c: drawing.c, w: drawing.w, p: chunk }); drawing.first = false; if (!drawing.keep) break; }
}
function canDraw() { return st && st.phase === 'drawing' && isDrawer(); }
cv.addEventListener('pointerdown', (e) => {
  if (!canDraw() || drawing || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault(); cv.setPointerCapture(e.pointerId);
  const p = pos(e);
  drawing = { id: e.pointerId, c: curColor(), w: tool.eraser ? tool.w * 1.6 | 0 : tool.w, first: true, last: p };
  const s = { c: drawing.c, w: drawing.w, p: [...p] }; strokes.push(s); drawing.s = s;
  seg(p, null, s.c, s.w);
  buf.push(...p); flush();
});
cv.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  e.preventDefault();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) {
    const p = pos(ev);
    if (Math.abs(p[0] - drawing.last[0]) + Math.abs(p[1] - drawing.last[1]) < 3) continue;
    seg(drawing.last, p, drawing.c, drawing.w); drawing.last = p; drawing.s.p.push(...p); buf.push(...p);
  }
  if (buf.length >= 60) { drawing.keep = true; flush(); drawing.keep = false; }
  else if (!flushT) flushT = setTimeout(flush, 50);
});
const endDraw = (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  if (flushT) clearTimeout(flushT);
  drawing.keep = true; flush(); drawing = null;
};
cv.addEventListener('pointerup', endDraw); cv.addEventListener('pointercancel', endDraw);
cv.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// tools
for (const c of COLORS) $('colors').append(el('button', { className: 'sw', type: 'button', title: c, style: `background:${c}`, ariaLabel: 'Color ' + c, onclick: () => { tool.c = c; tool.eraser = false; syncTools(); } }));
for (const w of SIZES) $('sizes').append(el('button', { className: 'sz', type: 'button', ariaLabel: 'Brush size ' + w, onclick: () => { tool.w = w; syncTools(); } }, el('i', { style: `width:${w / 1.6 + 4}px;height:${w / 1.6 + 4}px` })));
function syncTools() {
  [...$('colors').children].forEach((b, i) => b.setAttribute('aria-pressed', String(!tool.eraser && COLORS[i] === tool.c)));
  [...$('sizes').children].forEach((b, i) => b.setAttribute('aria-pressed', String(SIZES[i] === tool.w)));
  $('eraser').setAttribute('aria-pressed', String(tool.eraser));
}
$('eraser').onclick = () => { tool.eraser = !tool.eraser; syncTools(); };
$('clear').onclick = () => { if (!canDraw()) return; strokes = []; paintAll(); send({ t: 'clear' }); };
syncTools();

// ---------- actions ----------
const nameVal = () => $('name').value.trim();
function enter(msg) {
  const name = nameVal();
  if (!name) { $('homeErr').textContent = 'Enter a name first'; $('name').focus(); return; }
  try { localStorage.setItem(NAMEKEY, name); } catch {}
  $('homeErr').textContent = '';
  pendingEnter = { ...msg, name }; sess = null; st = null;
  if (ws && ws.readyState <= 1) { ws.onclose = null; ws.close(); ws = null; }
  connect();
}
$('create').onclick = () => enter({ t: 'create' });
$('join').onclick = () => enter({ t: 'join', code: $('code').value.trim().toUpperCase() });
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value ? $('join') : $('create')).click(); });
$('start').onclick = () => send({ t: 'start' });
$('invite').onclick = async () => {
  const link = `${location.origin}/?room=${st.code}`;
  try { await navigator.clipboard.writeText(link); $('invite').textContent = 'Copied!'; } catch { $('invite').textContent = link; }
  setTimeout(() => { $('invite').textContent = 'Copy invite link'; }, 2500);
};
$('guessForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('guess').value.trim(); $('guess').value = '';
  if (t) send({ t: 'guess', text: t });
});
function leave() {
  wantOpen = false; sess = null; saveSess(); st = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  show('home');
}
$('leaveLobby').onclick = leave;

// ---------- boot ----------
try { $('name').value = localStorage.getItem(NAMEKEY) || ''; } catch {}
const q = new URLSearchParams(location.search).get('room');
if (q) $('code').value = q.toUpperCase().slice(0, 4);
if (sess && !q) { show('home'); connect(); } else show('home');
window.__dd = () => ({ st, strokes: strokes.length, strokeData: strokes });
})();
