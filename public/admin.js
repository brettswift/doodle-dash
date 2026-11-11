'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? 'unavailable').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (at) => at == null ? 'unavailable' : new Date(at).toLocaleString('en-CA', { timeZone: 'America/Edmonton' });
  const table = (headers, rows) => '<div class="scroll"><table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const percent = (n) => n == null ? 'unavailable' : n + '%';
  let data;
  function render() {
    const { summary: s, health: h, operations: o } = data, a = s.audience, p = s.privateLobbies;
    const cards = [['Consented browsers', a.uniqueBrowsers], ['Seen on one day', a.singleDayBrowsers], ['Returning across days', a.returningBrowsers], ['Retained events', s.events]];
    $('out').innerHTML = '<h2>Audience</h2><p>Updated ' + esc(time(s.generatedAt)) + '. Observed from ' + esc(time(s.observedFrom)) + '.</p>' +
      '<div class="cards">' + cards.map(([label, value]) => '<div class="card"><strong>' + esc(value) + '</strong>' + esc(label) + '</div>').join('') + '</div>' +
      '<p>' + s.limitations.map(esc).join(' ') + '</p>' +
      '<h3>Daily new / returning browsers (' + esc(a.calendarTimezone) + ' calendar)</h3>' + table(['Day', 'Active', 'First observed', 'Returning'], a.daily.map((d) => [d.day, d.active, d.new, d.returning])) +
      '<h3>Exact-day browser retention</h3><p>Only completed target days enter denominator. No eligible cohort means unavailable, not 0%.</p>' +
      table(['Return day', 'Eligible browsers', 'Returned', 'Rate'], Object.entries(a.retention).map(([day, r]) => [day, r.eligible, r.returned, percent(r.percent)])) +
      '<h2>Games and lobby conversion</h2>' + table(['Mode', 'Started', 'Finished', 'Configured rounds avg', 'Configured distribution', 'Completed rounds avg', 'Completed distribution'], Object.entries(s.modes).map(([mode, m]) => [mode, m.gamesStarted, m.gamesFinished, m.configuredRounds.average, JSON.stringify(m.configuredRounds.distribution), m.completedRounds.average, JSON.stringify(m.completedRounds.distribution)])) +
      '<h3>Consented browser entry to start</h3><p>Public entry means queue; private entry means joining or creating a lobby. A browser counts once per mode within retained data, not once per attempt. Late joins after game start are not in the start cohort.</p>' + table(['Mode', 'Entered browsers', 'Reached start', 'Rate'], Object.entries(s.modes).map(([mode, m]) => [mode, m.consentedConversion.enteredBrowsers, m.consentedConversion.startedBrowsers, percent(m.consentedConversion.percent)])) +
      '<h3>Private lobbies, including never started</h3>' + table(['Created', 'Started', 'Closed without start', 'Waiting', 'Unknown after restart', 'Create-to-start'], [[p.created, p.started, p.closedWithoutStarting, p.currentlyWaiting, p.unknownAfterRestart || 0, p.created ? percent(p.createToStartRate) : 'unavailable']]) +
      '<h2>Service now</h2><p>Analytics ' + (h.analyticsEnabled ? 'enabled' : 'DISABLED') + '; QA ' + (h.qa ? 'yes (excluded)' : 'no') + '; game-start ntfy ' + (h.ntfyConfigured ? 'enabled, aggregate-only' : 'DISABLED') + '.</p>' +
      table(['Process CPU', 'RSS MiB', 'Heap MiB', 'Event-loop lag ms', 'Sockets', 'Rooms', 'Players', 'Rejected actions'], [[percent(h.cpuPercent), (h.rss / 1048576).toFixed(1), (h.heapUsed / 1048576).toFixed(1), h.eventLoopLagMs, h.openSockets, h.activeRooms, h.activePlayers, h.errorsSinceStart]]) +
      '<p>Ntfy sends since boot: ' + esc(h.ntfy.sent) + '; failures: ' + esc(h.ntfy.failed) + '; last success: ' + esc(time(h.ntfy.lastSentAt)) + '. Host CPU/memory unavailable. Other internal/process errors are not comprehensively counted; write failures appear as dropped events.</p>' +
      '<h3>Bounded service history</h3><p>' + esc(o.limitation) + ' Retention: up to ' + esc(o.retentionDays) + ' days; ' + esc(o.samples.length) + ' stored samples. Latest 120 below; CSV contains all retained samples.</p>' +
      table(['Time (Alberta)', 'CPU %', 'RSS MiB', 'Lag ms', 'Sockets', 'Rooms', 'Rejected actions', 'Dropped events'], o.samples.slice(-120).reverse().map((x) => [time(x.at), x.cpuPercent, (x.rss / 1048576).toFixed(1), x.eventLoopLagMs, x.openSockets, x.activeRooms, x.errorsSinceStart, x.droppedEvents])) +
      '<h2>Display names, not verified people</h2>' + table(['Name', 'First seen (Alberta)', 'Last seen (Alberta)', 'Sessions', 'Games', 'Coarse regions'], s.names.map((x) => [x.name, time(x.firstSeen), time(x.lastSeen), x.sessions, x.games, x.regions.join(', ') || 'unavailable']));
  }
  $('login').onsubmit = async (event) => {
    event.preventDefault(); $('err').textContent = ''; $('out').textContent = ''; $('csv').hidden = true; $('opsCsv').hidden = true;
    try {
      const response = await fetch('/admin/analytics.json', { cache: 'no-store', headers: { Authorization: 'Bearer ' + $('token').value } });
      if (!response.ok) throw Error(response.status === 401 ? 'Unauthorized' : 'Request failed: ' + response.status);
      data = await response.json(); render(); $('csv').hidden = false; $('opsCsv').hidden = false;
    } catch (error) { $('err').textContent = error.message; }
  };
  function download(name, rows) {
    const cell = (value) => { let s = String(value ?? 'unavailable'); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
    const url = URL.createObjectURL(new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('csv').onclick = () => download('crayon-breath-names.csv', [['name', 'first_seen_Alberta', 'last_seen_Alberta', 'sessions', 'games', 'regions'], ...data.summary.names.map((x) => [x.name, time(x.firstSeen), time(x.lastSeen), x.sessions, x.games, x.regions.join('|')])]);
  $('opsCsv').onclick = () => download('crayon-breath-service.csv', [['time_Alberta', 'process_cpu_percent', 'rss_bytes', 'heap_bytes', 'event_loop_lag_ms', 'sockets', 'rooms', 'rejected_actions_since_boot', 'dropped_events', 'run_id'], ...data.operations.samples.map((x) => [time(x.at), x.cpuPercent, x.rss, x.heapUsed, x.eventLoopLagMs, x.openSockets, x.activeRooms, x.errorsSinceStart, x.droppedEvents, x.runId])]);
})();
