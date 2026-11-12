'use strict';
const $ = (id) => document.getElementById(id);
const api = (p, body) =>
  fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    .then((r) => r.json());

/* ---------- Theme / onboarding ---------- */
const THEMES = ['meadow', 'midnight', 'sunset', 'lavender'];
function applyTheme(id) {
  if (!THEMES.includes(id)) id = 'meadow';
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('attune_theme', id); } catch {}
}
function showOnboard(force) {
  let saved = null; try { saved = localStorage.getItem('attune_theme'); } catch {}
  if (saved && !force) { applyTheme(saved); $('onboard').classList.add('hidden'); return; }
  $('onboard').classList.remove('hidden');
}
document.querySelectorAll('.vibe').forEach((btn) => {
  btn.onclick = () => { applyTheme(btn.dataset.pick); $('onboard').classList.add('hidden'); };
  btn.onmouseenter = () => { document.documentElement.dataset.theme = btn.dataset.pick; };
});
$('themeBtn').onclick = () => showOnboard(true);

/* ---------- Views ---------- */
const TITLES = { home: 'Companion', memory: 'Memory', connectors: 'Connectors' };
function switchView(v) {
  document.querySelectorAll('.navitem').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  $('htitle').textContent = TITLES[v] || '';
  if (v === 'memory') loadCalendar();
  if (v === 'connectors') loadConnectors();
}
document.querySelectorAll('.navitem').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));

/* ---------- Private mode ---------- */
$('incognito').onchange = async (e) => {
  const r = await api('/api/incognito', { on: e.target.checked });
  const np = $('privNote'); if (np) np.hidden = !r.private;
};

/* ---------- Memory calendar ---------- */
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let calData = {}, calToday = null, calView = null, selDay = null;
const key = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function loadCalendar() {
  const r = await api('/api/memory/calendar');
  calData = r.days || {}; calToday = r.today;
  if (!calView) { const d = new Date(calToday); calView = { y: d.getFullYear(), m: d.getMonth() }; }
  const np = $('privNote'); if (np) np.hidden = !r.private;
  renderCalendar();
}
function renderCalendar() {
  const { y, m } = calView;
  $('calTitle').textContent = `${MONTHS[m]} ${y}`;
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= days; d++) {
    const k = key(y, m, d), has = calData[k], isToday = k === calToday, sel = k === selDay;
    cells.push(`<div class="cal-cell ${has ? 'has' : ''} ${isToday ? 'today' : ''} ${sel ? 'sel' : ''}" data-key="${k}">${d}${has ? '<span class="cdot"></span>' : ''}</div>`);
  }
  $('calGrid').innerHTML = cells.join('');
}
function showDay(k) {
  const d = calData[k];
  if (!d) { $('dayDetail').innerHTML = '<div class="dd-empty">No memory for this day.</div>'; return; }
  const moments = d.moments.map((m) => `<div class="dd-moment">${m}</div>`).join('') || '<div class="dd-empty">No notable moments.</div>';
  $('dayDetail').innerHTML = `<h3>${k}</h3>${moments}<div style="margin-top:12px"><button class="mini danger" id="forgetDay">delete this day</button></div>`;
  $('forgetDay').onclick = async () => { await api('/api/memory/forgetDay', { date: k }); selDay = null; await loadCalendar(); $('dayDetail').innerHTML = '<div class="dd-empty">Deleted.</div>'; };
}
$('calGrid').addEventListener('click', (e) => { const c = e.target.closest('.cal-cell.has'); if (!c) return; selDay = c.dataset.key; renderCalendar(); showDay(selDay); });
$('calPrev').onclick = () => { if (--calView.m < 0) { calView.m = 11; calView.y--; } renderCalendar(); };
$('calNext').onclick = () => { if (++calView.m > 11) { calView.m = 0; calView.y++; } renderCalendar(); };
$('forgetAll').onclick = async () => { await api('/api/forget'); selDay = null; await loadCalendar(); $('dayDetail').innerHTML = '<div class="dd-empty">All memory cleared.</div>'; };

/* ---------- Connectors ---------- */
async function loadConnectors() {
  const r = await api('/api/connectors');
  $('connList').innerHTML = r.connectors.map((c) =>
    `<div class="conn-row ${c.connected ? 'on' : ''}" data-id="${c.id}"><div class="cava">${c.name[0]}</div><div class="cmeta"><b>${c.name}</b><span>${c.desc}</span></div><span class="cstatus">${c.connected ? 'connected' : 'not connected'}</span><button class="cbtn">${c.connected ? 'Disconnect' : 'Connect'}</button></div>`
  ).join('');
}
$('connList').addEventListener('click', async (e) => {
  const b = e.target.closest('.cbtn'); if (!b) return;
  const row = b.closest('.conn-row');
  await api('/api/connectors', { id: row.dataset.id, connected: !row.classList.contains('on') });
  loadConnectors();
});

/* ---------- Parallel signal agents ---------- */
const ICONS = {
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-5 4 10 2-5h8"/></svg>',
  face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.3 1.4 5.7 1.4 7 0"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>',
  breathing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12c3-7 7 7 10 0s7-7 10 0"/></svg>',
  hrv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l3-6 3 13 3-10 3 6 3-3h4"/></svg>',
};
let lastSignals = [], selectedSignal = null;
function renderSignals(sigs) {
  lastSignals = sigs || [];
  const c = $('signals');
  if (!lastSignals.length) { c.innerHTML = ''; $('signalDetail').hidden = true; return; }
  c.innerHTML = lastSignals.map((s) =>
    `<button class="sig ${s.status}${s.id === selectedSignal ? ' sel' : ''}" data-id="${s.id}"><span class="sdot"></span>${ICONS[s.id] || ''}<b>${s.label}</b><span class="sval">${s.value}</span></button>`
  ).join('');
  if (selectedSignal) { const a = lastSignals.find((x) => x.id === selectedSignal); a ? showDetail(a) : ($('signalDetail').hidden = true); }
}
function showDetail(a) {
  const pct = Math.round((a.confidence || 0) * 100);
  $('signalDetail').innerHTML = `<div class="sd-head"><b>${a.label} — ${a.value}</b><span>${a.status} · ${pct}%</span></div><div class="sd-body">${a.detail}</div>`;
  $('signalDetail').hidden = false;
}
$('signals').addEventListener('click', (e) => {
  const b = e.target.closest('.sig'); if (!b) return;
  selectedSignal = selectedSignal === b.dataset.id ? null : b.dataset.id;
  if (!selectedSignal) $('signalDetail').hidden = true;
  else { const a = lastSignals.find((x) => x.id === selectedSignal); if (a) showDetail(a); }
  renderSignals(lastSignals);
});

/* ---------- Companion ---------- */
let consent = false;
const LABEL = { consent_required: 'consent needed', starting: 'connecting', neutral: 'with you', elevated: 'elevated', unclear: 'signal unclear', calibrating: 'tuning in' };
function addMsg(text, who, opts = {}) {
  const el = document.createElement('div');
  el.className = `m ${who}`; el.textContent = text;
  if (opts.by) {
    const by = document.createElement('span'); by.className = 'by'; by.textContent = '↳ shaped by your body signal'; el.appendChild(by);
    const fix = document.createElement('button'); fix.className = 'fix'; fix.textContent = "that wasn't right";
    fix.onclick = async () => { await api('/api/correction', { wasAccurate: false }); fix.textContent = "thanks — I'll be gentler"; fix.disabled = true; };
    el.appendChild(fix);
  }
  $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight;
}
async function poll() {
  try {
    const s = await api('/api/state');
    consent = s.consent;
    const st = s.state || 'starting';
    $('state').textContent = LABEL[st] || st;
    $('mascot').dataset.state = st;
    $('pulse').textContent = s.pulseBpm == null ? '—' : s.pulseBpm;
    $('confLabel').textContent = !consent ? 'tap to begin' : st === 'calibrating' ? 'calibrating…' : st === 'unclear' ? 'signal low' : 'signal ' + Math.round((s.confidence || 0) * 100) + '%';
    renderSignals(s.signals);
    document.documentElement.classList.toggle('mood-elevated', consent && st === 'elevated');
    $('consentBtn').textContent = consent ? 'Sensing on — tap to pause' : 'Grant consent to sense';
    $('consentBtn').classList.toggle('on', consent);
    const show = consent && s.say && s.directive;
    $('nudgeBox').hidden = !show;
    if (show) { $('directive').textContent = s.directive; $('evidence').textContent = (s.evidence || []).join(' · '); }
  } catch {}
}
$('consentBtn').onclick = async () => { const r = await api('/api/consent', { allow: !consent }); consent = r.consent; poll(); };
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('msg').value.trim(); if (!text) return;
  $('msg').value = ''; addMsg(text, 'user');
  const r = await api('/api/chat', { message: text });
  addMsg(r.reply, 'bot', { by: r.usedBody });
};

/* ---------- boot ---------- */
setTimeout(() => $('mascot').classList.remove('greeting'), 2400); // hello wave, then settle to idle
showOnboard(false);
setInterval(poll, 400); poll();
addMsg("Hi — I'm here with you. Grant consent and I'll pay attention to how you're doing, not just what you say.", 'bot');
