'use strict';
const $ = (id) => document.getElementById(id);
// Per-boot session token injected by the server into index.html; required on every /api call.
const TOKEN = (document.querySelector('meta[name="attune-token"]') || {}).content || '';
const api = (p, body) =>
  fetch(p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-attune-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

/* ---------- Icons (assets/icons.svg sprite) ---------- */
const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="assets/icons.svg#i-${id}"/></svg>`;

/* ---------- Mood → color ----------
 * Starts calm (blue). Colors follow the mood read from the body signal + expression, and only switch
 * once a mood has held for MOOD_HOLD_MS so the palette never flickers. */
const MOOD_HOLD_MS = 1500;
let mood = 'calm', pendingMood = null, pendingSince = 0;
function moodFor(s) {
  if (!s.sensing || s.sensing.state !== 'active') return 'calm';
  if (s.state === 'elevated') return 'tense';
  const face = (s.signals || []).find((x) => x.id === 'face');
  const expr = face && face.status === 'active' ? face.value : null;
  if (expr === 'sad') return 'low';
  if (expr === 'smile') return 'bright';
  return 'calm';
}
function setMood(m) {
  mood = m; pendingMood = null;
  document.documentElement.dataset.mood = m;
  $('moodName').textContent = m;
}
function proposeMood(m, immediate = false) {
  if (m === mood) { pendingMood = null; return; }
  if (immediate) return setMood(m);
  if (pendingMood !== m) { pendingMood = m; pendingSince = Date.now(); return; }
  if (Date.now() - pendingSince >= MOOD_HOLD_MS) setMood(m);
}

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
  e.target.checked = r.private;
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
  $('dayDetail').innerHTML = `<h3>${k}</h3>${moments}<div class="dd-actions"><button class="mini danger" id="forgetDay">${icon('trash', 'sm')}delete this day</button></div>`;
  $('forgetDay').onclick = async () => { await api('/api/memory/forgetDay', { date: k }); selDay = null; await loadCalendar(); $('dayDetail').innerHTML = '<div class="dd-empty">Deleted.</div>'; };
}
$('calGrid').addEventListener('click', (e) => { const c = e.target.closest('.cal-cell.has'); if (!c) return; selDay = c.dataset.key; renderCalendar(); showDay(selDay); });
$('calPrev').onclick = () => { if (--calView.m < 0) { calView.m = 11; calView.y--; } renderCalendar(); };
$('calNext').onclick = () => { if (++calView.m > 11) { calView.m = 0; calView.y++; } renderCalendar(); };
$('forgetAll').onclick = async () => { await api('/api/forget'); selDay = null; await loadCalendar(); $('dayDetail').innerHTML = '<div class="dd-empty">All memory cleared.</div>'; };

/* ---------- Connectors ---------- */
const CONN_ICONS = { claude: 'claude', chatgpt: 'bot', mcp: 'cpu' };
async function loadConnectors() {
  const r = await api('/api/connectors');
  $('connList').innerHTML = r.connectors.map((c) =>
    `<div class="conn-row ${c.connected ? 'on' : ''}" data-id="${c.id}"><div class="cava">${icon(CONN_ICONS[c.id] || 'connectors')}</div><div class="cmeta"><b>${c.name}</b><span>${c.desc}</span></div><span class="cstatus">${c.connected ? 'connected' : 'not connected'}</span><button class="cbtn">${icon(c.connected ? 'unlink' : 'link', 'sm')}${c.connected ? 'Disconnect' : 'Connect'}</button></div>`
  ).join('');
}
$('connList').addEventListener('click', async (e) => {
  const b = e.target.closest('.cbtn'); if (!b) return;
  const row = b.closest('.conn-row');
  await api('/api/connectors', { id: row.dataset.id, connected: !row.classList.contains('on') });
  loadConnectors();
});

/* ---------- Parallel signal agents ---------- */
let lastSignals = [], selectedSignal = null;
function renderSignals(sigs) {
  lastSignals = sigs || [];
  const c = $('signals');
  if (!lastSignals.length) { c.innerHTML = ''; c.dataset.ids = ''; $('signalDetail').hidden = true; updateSlot(); return; }
  // Build the tiles once, then only patch text/classes so icons and dot animations don't restart every poll.
  const ids = lastSignals.map((s) => s.id).join(',');
  if (c.dataset.ids !== ids) {
    c.dataset.ids = ids;
    c.innerHTML = lastSignals.map((s) =>
      `<button class="sig" data-id="${s.id}"><span class="shead">${icon(s.id, 'sm')}<b>${s.label}</b><span class="sdot"></span></span><span class="sval"></span></button>`
    ).join('');
  }
  lastSignals.forEach((s) => {
    const el = c.querySelector(`.sig[data-id="${s.id}"]`);
    const cls = `sig ${s.status}${s.id === selectedSignal ? ' sel' : ''}`;
    if (el.className !== cls) el.className = cls;
    const v = el.querySelector('.sval');
    if (v.textContent !== s.value) v.textContent = s.value;
  });
  if (selectedSignal) { const a = lastSignals.find((x) => x.id === selectedSignal); a ? showDetail(a) : ($('signalDetail').hidden = true); }
}
function updateSlot() {
  $('slotEmpty').hidden = !$('signalDetail').hidden || !$('nudgeBox').hidden || !$('insightBox').hidden;
}
function showDetail(a) {
  const pct = Math.round((a.confidence || 0) * 100);
  $('signalDetail').innerHTML = `<div class="sd-head"><b>${a.label} — ${a.value}</b><span>${a.status} · ${pct}%</span></div><div class="sd-body">${a.detail}</div>`;
  $('signalDetail').hidden = false;
  updateSlot();
}
$('signals').addEventListener('click', (e) => {
  const b = e.target.closest('.sig'); if (!b) return;
  selectedSignal = selectedSignal === b.dataset.id ? null : b.dataset.id;
  if (!selectedSignal) { $('signalDetail').hidden = true; updateSlot(); }
  else { const a = lastSignals.find((x) => x.id === selectedSignal); if (a) showDetail(a); }
  renderSignals(lastSignals);
});

/* ---------- Companion ---------- */
let consent = false, lastState = null;
const LABEL = { consent_required: 'consent needed', starting: 'starting camera', error: 'sensor error', off: 'paused', neutral: 'with you', elevated: 'elevated', unclear: 'signal unclear', calibrating: 'tuning in' };
function addMsg(text, who, opts = {}) {
  const el = document.createElement('div');
  el.className = `m ${who}`; el.textContent = text;
  if (opts.by) {
    const by = document.createElement('span'); by.className = 'by'; by.textContent = '↳ shaped by your body signal'; el.appendChild(by);
    const fix = document.createElement('button'); fix.className = 'fix'; fix.innerHTML = icon('undo', 'sm') + "that wasn't right";
    fix.onclick = async () => { await api('/api/correction', { wasAccurate: false }); fix.textContent = "thanks — I'll be gentler"; fix.disabled = true; };
    el.appendChild(fix);
  }
  $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight;
}
async function poll() {
  try {
    const s = await api('/api/state');
    const c = s.consent || {};
    consent = !!c.sensing;
    const st = s.state || 'starting';
    $('incognito').checked = !c.memory;
    $('aiNote').hidden = !consent || !!c.aiSharing;
    $('hint').hidden = !(s.sensing && s.sensing.simulated);
    $('sensorError').hidden = !(s.sensing && s.sensing.error);
    if (s.sensing && s.sensing.error) $('sensorError').textContent = `Sensor could not start: ${s.sensing.error}`;
    $('state').textContent = LABEL[st] || st;
    $('mascot').dataset.state = st;
    $('pulse').textContent = s.pulseBpm == null ? '—' : s.pulseBpm;
    $('confLabel').textContent = !consent ? 'tap to begin' : st === 'starting' ? 'starting…' : st === 'calibrating' ? 'calibrating…' : st === 'unclear' ? 'signal low' : 'signal ' + Math.round((s.confidence || 0) * 100) + '%';
    renderSignals(s.signals);
    proposeMood(moodFor(s));
    const active = s.sensing && s.sensing.state === 'active';
    const errored = s.sensing && s.sensing.state === 'error';
    if (!errored) $('consentLabel').textContent = consent ? 'Sensing on — tap to pause' : 'Grant consent to sense';
    $('insightBox').hidden = !active;
    if (s.insight) {
      if ($('insightText').textContent !== s.insight.text) $('insightText').textContent = s.insight.text;
      $('insightMeta').textContent = `${s.insight.origin} · ${new Date(s.insight.receivedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (errored) $('consentLabel').textContent = 'Sensor stopped — tap to reset';
    const iconHref = `assets/icons.svg#i-${consent ? 'pause' : 'consent'}`;
    if ($('consentIcon').getAttribute('href') !== iconHref) $('consentIcon').setAttribute('href', iconHref);
    $('consentBtn').classList.toggle('on', consent);
    const show = consent && s.say && s.directive;
    $('nudgeBox').hidden = !show;
    if (show) { $('directive').textContent = s.directive; $('evidence').textContent = (s.evidence || []).join(' · '); }
    updateSlot();
    lastState = s;
  } catch (e) {
    if (!(e instanceof TypeError && /fetch/i.test(e.message))) console.error('poll failed:', e); // network blips stay quiet
  }
}
/* ---------- Presage check-in (user-initiated Insight; the answer arrives later) ---------- */
$('askInsight').onclick = async () => {
  const r = await api('/api/insight', {});
  $('insightStatus').textContent = r.requestId != null ? 'Asked Presage — the answer will appear above.' : 'Please wait 30 seconds between check-ins.';
  setTimeout(() => { $('insightStatus').textContent = ''; }, 6000);
};

/* ---------- Consent dialog (the only way sensing can start) ---------- */
function openConsent() {
  $('cSensing').checked = false; $('cPresage').checked = false;
  $('cAi').checked = false; $('cMemory').checked = false;
  $('consentErr').hidden = true;
  syncConsentForm();
  $('consentDlg').hidden = false;
  $('cSensing').focus();
}
function syncConsentForm() { $('consentStart').disabled = !($('cSensing').checked && $('cPresage').checked); }
['cSensing', 'cPresage'].forEach((id) => ($(id).onchange = syncConsentForm));
$('consentCancel').onclick = () => { $('consentDlg').hidden = true; };
$('consentStart').onclick = async () => {
  const r = await api('/api/consent', { sensing: true, presageAck: true, aiSharing: $('cAi').checked, memory: $('cMemory').checked });
  if (r.error) { $('consentErr').textContent = r.error; $('consentErr').hidden = false; return; }
  $('consentDlg').hidden = true;
  poll();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('consentDlg').hidden) $('consentDlg').hidden = true; });
$('consentBtn').onclick = async () => {
  if (!consent) return openConsent();
  await api('/api/revoke', { scopes: ['sensing'] });
  poll();
};
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('msg').value.trim(); if (!text) return;
  $('msg').value = ''; addMsg(text, 'user');
  const r = await api('/api/chat', { message: text });
  addMsg(r.reply, 'bot', { by: r.usedBody });
  if (lastState) proposeMood(moodFor({ ...lastState, state: r.state || lastState.state }), true);
};

/* ---------- boot ---------- */
setTimeout(() => $('mascot').classList.remove('greeting'), 2400); // hello wave, then settle to idle
setInterval(poll, 400); poll();
addMsg("Hi — I'm here with you. If you turn on sensing (and choose to share it with me), I'll pay attention to how you're doing, not just what you say.", 'bot');
