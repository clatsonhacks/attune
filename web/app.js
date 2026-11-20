'use strict';
const $ = (id) => document.getElementById(id);
// Per-boot session token injected by the server into index.html; required on every /api call.
const TOKEN = (document.querySelector('meta[name="attune-token"]') || {}).content || '';
const api = (p, body) =>
  fetch(p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-attune-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => {
    if (r.status === 401) { staleToken(); throw new Error('stale session token'); }
    try { sessionStorage.removeItem('attune_reloads'); } catch {}
    return r.json();
  });

// The server makes a new session token every time it starts. A tab left open across a restart still holds
// the old one, so reload (at most twice in a row) to get the new token instead of showing errors.
let reloading = false;
function staleToken() {
  if (reloading) return;
  let n = 0;
  try { n = Number(sessionStorage.getItem('attune_reloads')) || 0; sessionStorage.setItem('attune_reloads', String(n + 1)); } catch {}
  if (n < 2) { reloading = true; location.reload(); }
}

/* ---------- Scrolling (OverlayScrollbars library) ---------- */
const OverlayScrollbars = window.OverlayScrollbarsGlobal && window.OverlayScrollbarsGlobal.OverlayScrollbars;
const REDUCED_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SCROLL_OPTS = { overflow: { x: 'hidden' }, scrollbars: { theme: 'os-theme-attune', autoHide: 'leave', autoHideDelay: 500, clickScroll: true } };
/** Thin overlay scrollbars on `host`; `viewport` (if given) stays the element that scrolls and holds content. */
if (OverlayScrollbars) {
  const nonce = (document.querySelector('meta[name="attune-style-nonce"]') || {}).content;
  if (nonce) OverlayScrollbars.nonce(nonce); // must be set before the first instance is created
}
function scrollArea(host, viewport, opts = SCROLL_OPTS) {
  if (!OverlayScrollbars || !host) return null;
  return OverlayScrollbars(viewport ? { target: host, elements: { viewport, content: false } } : host, opts);
}

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
const TITLES = { home: 'Companion', sensing: 'Sensing details', memory: 'Memory', keys: 'API Keys', connectors: 'Connectors', activity: 'Activity' };
let currentView = 'home';
function switchView(v) {
  if (currentView === 'keys' && v !== 'keys') {
    for (const id of Object.keys(keyRoutes)) { $(id + 'Input').value = ''; $(id + 'Save').disabled = true; }
  }
  $(v === 'sensing' ? 'detailSignals' : 'homeSignals').append($('signals'));
  currentView = v;
  document.querySelectorAll('.navitem').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === v);
    if (n.dataset.view === v) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  $('htitle').textContent = TITLES[v] || '';
  $('modeSeg').hidden = v !== 'home' || !lenses.length;
  syncPacer();
  if (v === 'memory') loadCalendar();
  if (v === 'connectors') refreshApps(true).then(loadConnectors);
  if (v === 'activity') refreshApps().then(() => loadActivity());
}
document.querySelectorAll('.navitem').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));

function openSensing() {
  switchView('sensing');
  $('backFromSensing').focus();
}
$('openSensing').onclick = $('readInstruction').onclick = openSensing;
$('backFromSensing').onclick = () => { switchView('home'); $('openSensing').focus(); };
$('homeToggle').onclick = () => {
  const show = $('view-home').classList.toggle('show-sensing');
  $('homeToggle').textContent = show ? 'Show chat' : 'Show sensing';
};
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
const CONN_ICONS = { 'claude-desktop': 'claude', chatgpt: 'bot' };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function connectorLink(label, href) {
  const link = el('a', 'cbtn', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

// Setup snippets scroll sideways inside a thin overlay scrollbar (instances are destroyed when the list is rebuilt).
const SNIPPET_SCROLL = { ...SCROLL_OPTS, overflow: { x: 'scroll', y: 'hidden' } };
let snippetScrolls = [];

function copyConnectorText(text, label) {
  const button = el('button', 'mini', label);
  const feedback = el('span');
  feedback.setAttribute('role', 'status');
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = 'Copied.';
    } catch {
      feedback.textContent = 'Select the text and copy it manually.';
    }
  };
  const pre = el('pre', 'snippet', text);
  pre.tabIndex = 0;
  const host = el('div', 'snippet-host');
  host.append(pre);
  const block = el('div');
  block.append(host, button, feedback);
  return block;
}

$('claudeVoiceSetup').onclick = () => {
  switchView('connectors');
  $('claudeVoiceGuide').open = true;
  $('claudeVoiceGuide').querySelector('summary').focus();
};
$('openClaudeVoice').onclick = async () => {
  $('openClaudeVoice').disabled = true;
  try {
    const result = await api('/api/connectors/claude/open', {});
    $('claudeVoiceStatus').textContent = result.ok ? 'Select the sound-wave icon in Claude to start talking.' : result.error;
  } catch { $('claudeVoiceStatus').textContent = 'Could not open Claude Desktop.'; }
  finally { $('openClaudeVoice').disabled = false; }
};
function renderClaudeSetup(meta, connector, options) {
  $('openClaudeVoice').hidden = !options.openClaudeAvailable;
  if (options.extensionAvailable) {
    const install = el('a', 'cbtn', 'Install in Claude');
    install.href = '/downloads/attune.mcpb';
    install.download = 'attune.mcpb';
    meta.append(install, el('span', null, 'Open the downloaded extension in Claude Desktop and confirm installation. Choose its allowed purposes below.'));
  }
  if (options.restartAvailable) {
    const restart = el('button', 'mini', 'Restart Claude Desktop');
    const feedback = el('span');
    feedback.setAttribute('role', 'status');
    restart.onclick = async () => {
      if (!window.confirm('Restart Claude Desktop now? Save drafts and finish running sessions first.')) return;
      restart.disabled = true;
      try {
        const result = await api('/api/connectors/claude/restart', { confirmed: true });
        feedback.textContent = result.ok ? 'Claude Desktop is reopening.' : result.error;
      } catch { feedback.textContent = 'Could not reach Attune.'; }
      finally { restart.disabled = false; }
    };
    meta.append(restart, feedback);
  }
  if (options.desktop) return;
  if (connector.registered) {
    meta.append(el('span', null, connector.pointsToThisInstall
      ? 'Registered in Claude Desktop. Camera sensing, AI sharing and memory follow your choices here in Attune.'
      : 'Claude Desktop already has an Attune entry for another installation. Review it in Claude Desktop.'));
    return;
  }
  if (connector.status === 'unreadable') {
    meta.append(el('span', null, 'Claude Desktop settings could not be read. Check them and reopen this page.'));
    return;
  }
  const connect = el('button', 'cbtn', 'Connect Claude');
  const panel = el('div', 'conn-setup');
  panel.hidden = true;
  connect.setAttribute('aria-expanded', 'false');
  connect.setAttribute('aria-controls', 'claudeSetup');
  panel.id = 'claudeSetup';
  connect.onclick = () => {
    panel.hidden = !panel.hidden;
    connect.setAttribute('aria-expanded', String(!panel.hidden));
  };

  const label = el('label', 'opt');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, el('span', null, 'Allow Claude to request camera sensing and receive interpreted context. ' +
    'Presage SmartSpectra sends physiological measurements to Presage for Insights.'));
  const add = el('button', 'mini', 'Register in Claude Desktop');
  add.disabled = true;
  checkbox.onchange = () => { add.disabled = !checkbox.checked; };
  const feedback = el('span');
  feedback.setAttribute('role', 'status');
  add.onclick = async () => {
    add.disabled = checkbox.disabled = true;
    try {
      const result = await api('/api/connectors/claude', { approved: checkbox.checked });
      if (result.ok) {
        feedback.textContent = 'Registered. Fully quit and reopen Claude Desktop to load Attune.';
        feedback.tabIndex = -1;
        feedback.focus();
        label.remove();
        add.remove();
        return;
      }
      feedback.textContent = result.error || 'Claude Desktop setup failed. Try again.';
    } catch {
      feedback.textContent = 'Claude Desktop setup failed. Try again.';
    }
    checkbox.disabled = false;
    add.disabled = !checkbox.checked;
  };

  panel.append(el('span', null, 'Attune adds an entry to Claude Desktop settings. You can remove it from Claude Desktop to revoke access.'),
    connectorLink('Presage privacy policy', 'https://api.physiology.presagetech.com/privacypolicy'), label, add, feedback);
  meta.append(connect, panel);
}

function renderChatGPTSetup(meta, connector) {
  const setup = el('details', 'conn-setup');
  setup.append(el('summary', null, 'Secure MCP Tunnel setup'),
    el('span', null, 'Create a tunnel for your ChatGPT workspace and use the command below as the local stdio MCP server. ' +
      'Then select the tunnel in ChatGPT under Add custom MCP server.'),
    connectorLink('OpenAI tunnel setup guide', 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'),
    copyConnectorText(connector.command, 'Copy server command'),
    el('span', null, 'Keep Attune open while you use it. ChatGPT gets nothing until you allow a purpose for it below, ' +
      'and only while camera sensing and AI sharing are on in Attune. It can then request readings, which can turn on the camera. ' +
      'It receives interpreted context. Presage receives physiological measurements for Insights. Stop the tunnel client to disconnect.'));
  const connect = connectorLink('Connect ChatGPT', 'https://chatgpt.com/plugins');
  connect.addEventListener('click', () => { setup.open = true; });
  meta.append(connect, setup);
}

async function loadConnectors() {
  const list = $('connList');
  try {
    const result = await api('/api/connectors');
    snippetScrolls.forEach((s) => s && s.destroy());
    snippetScrolls = [];
    list.replaceChildren();
    for (const connector of result.connectors) {
      const row = el('div', connector.registered ? 'conn-row on' : 'conn-row');
      const avatar = el('div', 'cava');
      avatar.innerHTML = icon(CONN_ICONS[connector.id] || 'connectors');
      const meta = el('div', 'cmeta');
      meta.append(el('b', null, connector.name));
      if (connector.id === 'claude-desktop') renderClaudeSetup(meta, connector, result);
      if (connector.id === 'chatgpt') renderChatGPTSetup(meta, connector);
      if (connector.id === 'other') {
        const setup = el('details', 'conn-setup');
        setup.append(el('summary', null, 'Show MCP configuration JSON'),
          el('span', null, 'For clients that support local stdio MCP. The connector talks to Attune while it is open; ' +
            'camera sensing, AI sharing and the purposes each app may use are set here in Attune. Presage receives physiological measurements for Insights.'),
          copyConnectorText(connector.snippet, 'Copy JSON'));
        meta.append(setup);
      }
      if (KNOWN_APPS[connector.id]) {
        const slot = el('div', 'purposes-slot');
        slot.dataset.app = connector.id;
        meta.append(slot);
      }
      row.append(avatar, meta);
      list.append(row);
    }
    list.querySelectorAll('.snippet-host').forEach((host) => snippetScrolls.push(scrollArea(host, host.firstChild, SNIPPET_SCROLL)));
  } catch {
    list.replaceChildren(el('p', null, 'Could not load connectors. Reopen this page to try again.'));
  }
  renderApps();
}

/* ---------- Purposes (lenses) each app may use, and requests waiting for the person ---------- */
// Only the person decides here; an AI can ask for a purpose (shown as a pending request) but never approve one.
const KNOWN_APPS = { 'claude-desktop': 'Claude Desktop', chatgpt: 'ChatGPT' };
const SHORT_LENS = { companion: 'Companion' };
let lenses = [], appsData = { apps: [], pending: [], lastSeen: {} }, appsSig = '';
const lensById = (id) => lenses.find((l) => l.id === id);
const lensName = (id) => (lensById(id) || {}).name || id || 'an unknown purpose';
const appEntry = (id) => appsData.apps.find((a) => a.id === id);
const appName = (id) => (appEntry(id) || {}).name || KNOWN_APPS[id] || id;

async function loadLenses() {
  try { const r = await api('/api/lenses'); lenses = Array.isArray(r.lenses) ? r.lenses : []; } catch {}
  renderModeSeg();
}

async function refreshApps(force = false) {
  let r;
  try { r = await api('/api/apps'); } catch { return; }
  if (!r || !Array.isArray(r.apps)) return;
  const next = { apps: r.apps, pending: Array.isArray(r.pending) ? r.pending : [], lastSeen: r.lastSeen && typeof r.lastSeen === 'object' ? r.lastSeen : {} };
  // Also rebuild once a minute so "5 min ago" on a pending request or a connection stays right.
  const sig = JSON.stringify(next) + ':' + Math.floor(Date.now() / 60000);
  if (!force && sig === appsSig) return;
  appsData = next; appsSig = sig;
  renderBadge();
  renderApps();
}

function renderBadge() {
  const n = appsData.pending.length, b = $('pendingBadge');
  b.hidden = !n;
  b.textContent = n > 9 ? '9+' : String(n);
  b.setAttribute('aria-label', n === 1 ? '1 request waiting' : `${n} requests waiting`);
}

// Rebuilding a list must not throw away keyboard focus: remember the focused control by key and restore it.
function keepFocus(container, build) {
  const a = document.activeElement;
  const k = a && container.contains(a) ? a.dataset.fkey : null;
  build();
  if (k) { const n = container.querySelector(`[data-fkey="${CSS.escape(k)}"]`); if (n && !n.disabled) n.focus(); }
}

async function decide(app, lens, allow, status) {
  const body = { app, lens, allow };
  const known = (appEntry(app) || {}).name || KNOWN_APPS[app];
  if (known) body.name = known;
  try {
    const r = await api('/api/apps/lens', body);
    if (!r.ok) throw new Error(r.error || 'failed');
  } catch (e) {
    if (status) status.textContent = e.message && e.message !== 'failed' ? e.message : 'Could not save that. Try again.';
    await refreshApps(true);
    return false;
  }
  await refreshApps(true);
  return true;
}

function renderPending() {
  const card = $('pendingCard'), list = $('pendingList');
  const items = [...appsData.pending].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  card.hidden = !items.length;
  $('pendingTitle').textContent = items.length === 1 ? 'An app is asking for a new purpose' : `${items.length} requests are waiting for you`;
  keepFocus(list, () => {
    list.replaceChildren(...items.map((p) => {
      const li = el('li', 'pending-row');
      const text = el('div', 'pending-text');
      const line = el('div', 'pending-line');
      line.append(el('b', null, appName(p.app)), document.createTextNode(' asked to use '), el('b', null, lensName(p.lens)));
      const lens = lensById(p.lens);
      const sub = el('small', null, `${relTime(p.at)}${lens ? ' · ' + lens.description : ''}`);
      text.append(line, sub);
      const status = el('span', 'pending-status');
      status.setAttribute('role', 'status');
      text.append(status);
      const allow = el('button', 'cta small');
      allow.innerHTML = icon('check', 'sm');
      allow.append('Allow');
      const deny = el('button', 'mini');
      deny.innerHTML = icon('close', 'sm');
      deny.append('Deny');
      allow.dataset.fkey = `allow:${p.app}:${p.lens}`;
      deny.dataset.fkey = `deny:${p.app}:${p.lens}`;
      const label = `${appName(p.app)} — ${lensName(p.lens)}`;
      allow.setAttribute('aria-label', `Allow ${label}`);
      deny.setAttribute('aria-label', `Deny ${label}`);
      const act = async (yes) => {
        allow.disabled = deny.disabled = true;
        const ok = await decide(p.app, p.lens, yes, status);
        if (ok && !$('pendingCard').contains(document.activeElement)) {
          const nextBtn = $('pendingList').querySelector('button');
          (nextBtn || $('connList').querySelector(`.purposes-slot[data-app="${CSS.escape(p.app)}"] input`) || $('connTitle')).focus();
        }
      };
      allow.onclick = () => act(true);
      deny.onclick = () => act(false);
      const btns = el('div', 'pending-actions');
      btns.append(deny, allow);
      li.append(text, btns);
      return li;
    }));
  });
}



/** Toggles for the lenses one app may use, plus "Remove app". */
function purposesBlock(app) {
  const box = el('div', 'purposes');
  const head = el('div', 'p-head');
  head.append(el('span', 'p-title', 'Purposes it may use'));
  const remove = el('button', 'mini danger');
  remove.innerHTML = icon('trash', 'sm');
  remove.append('Remove app');
  remove.dataset.fkey = `remove:${app.id}`;
  remove.setAttribute('aria-label', `Remove ${app.name}`);
  const status = el('span', 'p-status');
  status.setAttribute('role', 'status');
  remove.onclick = async () => {
    if (!confirm(`Remove ${app.name} from Attune?\n\nIts approvals and requests are deleted. If it connects again it can only use Emotional companion until you allow more.`)) return;
    remove.disabled = true;
    try {
      const r = await api('/api/apps/remove', { app: app.id });
      if (!r.ok) throw new Error(r.error);
    } catch (e) { status.textContent = (e && e.message) || 'Could not remove the app. Try again.'; remove.disabled = false; return; }
    await refreshApps(true);
    $('connTitle').focus();
  };
  head.append(remove);
  const ul = el('ul', 'lens-list');
  for (const lens of lenses) {
    const li = el('li');
    const label = el('label', 'ltog');
    const input = el('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = app.lenses.includes(lens.id);
    input.dataset.fkey = `lens:${app.id}:${lens.id}`;
    const txt = el('span', 'ltxt');
    txt.append(el('b', null, lens.name), el('small', null, lens.description));
    input.onchange = async () => {
      input.disabled = true;
      status.textContent = '';
      await decide(app.id, lens.id, input.checked, status);
      input.disabled = false;
    };
    label.append(input, txt);
    li.append(label);
    ul.append(li);
  }
  box.append(head, ul, status);
  return box;
}

/** "Connected — seen 2 min ago" (the app's connector reached Attune since it opened), or "Not seen yet". */
function seenLine(id) {
  const at = (appEntry(id) || {}).lastSeenAt || appsData.lastSeen[id];
  const when = at ? relTime(at) : '';
  return el('small', at ? 'seen on' : 'seen', when ? `Connected — seen ${when}` : 'Not seen yet');
}

function renderApps() {
  renderPending();
  const others = appsData.apps.filter((a) => !a.builtin && !KNOWN_APPS[a.id]);
  for (const slot of $('connList').querySelectorAll('.purposes-slot')) {
    const app = appEntry(slot.dataset.app);
    const strict = slot.dataset.app === 'chatgpt'; // the ChatGPT profile gets nothing without an explicit approval
    keepFocus(slot, () => {
      if (app && !app.builtin) slot.replaceChildren(seenLine(slot.dataset.app), purposesBlock(app));
      else slot.replaceChildren(seenLine(slot.dataset.app), el('span', 'p-default', strict
        ? 'Until you choose, it may use no purpose. When it asks for one, the request shows up here.'
        : `Until you choose, it may use ${lensName('companion')} only. If it asks for another purpose, the request shows up here.`));
    });
  }
  const list = $('appList');
  $('appsSec').hidden = !others.length;
  keepFocus(list, () => {
    list.replaceChildren(...others.map((app) => {
      const row = el('div', 'conn-row on');
      const avatar = el('div', 'cava');
      avatar.innerHTML = icon('bot');
      const meta = el('div', 'cmeta');
      meta.append(el('b', null, app.name), seenLine(app.id), purposesBlock(app));
      row.append(avatar, meta);
      return row;
    }));
  });
}

/** "just now", "5 min ago", "3 h ago", then a date. */
function relTime(at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------- Activity: who read which purpose, and when (number-free log) ---------- */
const KIND_ICON = { context: 'check', request: 'bell', denied: 'close', unknown: 'close' };
const BLOCKED_STATES = new Set(['consent_required', 'unavailable']);
const STATE_WORDS = { consent_required: "couldn't read — camera or sharing is off", unavailable: "couldn't read — camera unavailable",
  starting: 'read context — camera starting', calibrating: 'read context — still tuning in', off: 'read context — camera off',
  stale: 'read context — reading too old', paused: 'read context — camera paused', unclear: 'read context — signal unclear' };
function describeEvent(e) {
  const lens = e.lens ? lensName(e.lens) : null;
  if (e.kind === 'request') return `asked for ${lens || 'a purpose'} (waiting for you)`;
  if (e.kind === 'denied') return `asked for ${lens || 'a purpose'} (not approved)`;
  if (e.kind === 'unknown') return 'asked for an unknown purpose';
  const base = (e.state && STATE_WORDS[e.state]) || `read context — ${e.state ? e.state.replace(/_/g, ' ') : 'no state'}`;
  return e.say ? `${base} · shared a gentle cue` : base;
}
let activitySig = '';
async function loadActivity(force = false) {
  let r;
  try { r = await api('/api/activity?limit=200'); } catch { return; }
  const events = (Array.isArray(r.events) ? r.events : []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // Rebuild when the log changes, and once a minute anyway so the relative times stay right.
  const sig = JSON.stringify(events) + ':' + Math.floor(Date.now() / 60000);
  if (!force && sig === activitySig) return;
  activitySig = sig;
  $('actEmpty').hidden = events.length > 0;
  $('actHost').hidden = !events.length;
  $('clearActivity').disabled = !events.length;
  $('actList').replaceChildren(...events.map((e) => {
    const blocked = e.kind === 'context' && BLOCKED_STATES.has(e.state);
    const li = el('li', `act-row k-${blocked ? 'blocked' : e.kind}`);
    const ic = el('span', 'act-ic');
    ic.innerHTML = icon(blocked ? 'lock' : KIND_ICON[e.kind] || 'history', 'sm');
    const body = el('div', 'act-body');
    const top = el('div', 'act-top');
    top.append(el('b', null, appName(e.app)));
    if (e.lens) top.append(el('span', 'act-lens', lensName(e.lens)));
    body.append(top, el('div', 'act-what', describeEvent(e)));
    const time = el('time', 'act-time', relTime(e.at));
    time.dateTime = e.at;
    time.title = new Date(e.at).toLocaleString();
    li.append(ic, body, time);
    return li;
  }));
}
$('clearActivity').onclick = async () => {
  if (!confirm('Clear all activity?\n\nThis deletes the list of which apps used Attune. It does not change any approvals.')) return;
  try { await api('/api/activity/clear', {}); } catch {}
  await loadActivity(true);
  $('actEmpty').focus();
};

/* ---------- Companion mode (which lens the built-in companion reads through) ---------- */
let lensMode = null;
function renderModeSeg() {
  const seg = $('modeSeg');
  if (!lenses.length) { seg.hidden = true; return; }
  const ids = lenses.map((l) => l.id).join(',');
  if (seg.dataset.ids !== ids) {
    seg.dataset.ids = ids;
    seg.replaceChildren(...lenses.map((l) => {
      const b = el('button', 'seg-btn');
      b.innerHTML = icon(`lens-${l.id}`); // icon-only; the name is in the tooltip and aria-label
      b.type = 'button';
      b.dataset.lens = l.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', l.name);
      b.title = `${l.name} — ${l.description}`;
      b.onclick = () => setMode(l.id);
      return b;
    }));
  }
  seg.hidden = false;
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.lens === (lensMode || 'companion');
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}
// Radio-group keyboard: arrows move and select, like native radios.
$('modeSeg').addEventListener('keydown', (e) => {
  const btns = [...$('modeSeg').querySelectorAll('.seg-btn')];
  const i = btns.indexOf(document.activeElement);
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (i < 0 || !d) return;
  e.preventDefault();
  const n = btns[(i + d + btns.length) % btns.length];
  n.focus();
  setMode(n.dataset.lens);
});
let modeBusy = false;
async function setMode(id) {
  if (id === lensMode || modeBusy) return;
  const prev = lensMode;
  lensMode = id; modeBusy = true;
  renderModeSeg(); syncPacer();
  try {
    const r = await api('/api/mode', { lens: id });
    if (!r.ok) throw new Error(r.error);
    lensMode = r.lensMode;
  } catch { lensMode = prev; }
  modeBusy = false;
  renderModeSeg(); syncPacer();
}

/* ---------- Yoga mode: the same mascot card; the mascot breathes at ~6 breaths/min (in 4 s, out 6 s) ---------- */
const INHALE_MS = 4000, EXHALE_MS = 6000, CYCLE_MS = INHALE_MS + EXHALE_MS;
let pacerT0 = 0, pacerTimer = null, breathMeasured = '';
function syncPacer() {
  const yoga = lensMode === 'yoga';
  const on = yoga && currentView === 'home';
  const m = $('mascot');
  m.classList.toggle('breathe', yoga);
  $('breathCue').hidden = !yoga;
  if (on && !pacerTimer) {
    pacerT0 = performance.now();
    m.classList.remove('breathe'); void m.offsetWidth; m.classList.add('breathe'); // restart in step with the words
    tickPacer();
    pacerTimer = setInterval(tickPacer, 250);
  } else if (!on && pacerTimer) {
    clearInterval(pacerTimer); pacerTimer = null;
  }
}
function tickPacer() {
  const t = (performance.now() - pacerT0) % CYCLE_MS;
  const inhale = t < INHALE_MS;
  const left = Math.ceil(((inhale ? INHALE_MS : CYCLE_MS) - t) / 1000);
  const word = (inhale ? 'Breathe in' : 'Breathe out') + (REDUCED_MOTION ? ` · ${left}` : '');
  const text = `${word} · goal 6/min${breathMeasured ? ` · ${breathMeasured}` : ''}`;
  if ($('breathCue').textContent !== text) $('breathCue').textContent = text;
  $('mascot').dataset.phase = inhale ? 'in' : 'out';
}
function renderMeasuredBreath(signals, sensingActive, breath) {
  // Prefer the measured rate the yoga lens uses; fall back to the breathing tile.
  const b = (signals || []).find((x) => x.id === 'breathing');
  const measured = breath && typeof breath.perMin === 'number' ? `${breath.perMin}/min` : null;
  const v = measured || (b && /\d\/min$/.test(b.value || '') ? b.value : null);
  const talking = (breath && breath.talking) || (b && b.value === 'paused');
  breathMeasured = v ? `you ${v}` : sensingActive ? (talking ? 'paused while talking' : 'measuring…') : '';
}

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
  selectedSignal = currentView === 'sensing' && selectedSignal === b.dataset.id ? null : b.dataset.id;
  if (currentView === 'home') openSensing();
  if (!selectedSignal) { $('signalDetail').hidden = true; updateSlot(); }
  else { const a = lastSignals.find((x) => x.id === selectedSignal); if (a) showDetail(a); }
  renderSignals(lastSignals);
});

/* ---------- Companion ---------- */
let consent = false, lastState = null;
const LABEL = { consent_required: 'consent needed', starting: 'starting camera', error: 'sensor error', off: 'paused', standby: 'camera off', paused: 'paused', neutral: 'with you', elevated: 'elevated', unclear: 'signal unclear', calibrating: 'tuning in' };
function addMsg(text, who, opts = {}) {
  const el = document.createElement('div');
  el.className = `m ${who}`; el.textContent = text;
  if (opts.by) {
    const by = document.createElement('span'); by.className = 'by'; by.textContent = '↳ shaped by your body signal'; el.appendChild(by);
    const fix = document.createElement('button'); fix.className = 'fix'; fix.innerHTML = icon('undo', 'sm') + "that wasn't right";
    fix.onclick = async () => { await api('/api/correction', { wasAccurate: false }); fix.textContent = "thanks — I'll be gentler"; fix.disabled = true; };
    el.appendChild(fix);
  }
  if ('instruction' in opts) {
    const details = document.createElement('details');
    details.className = 'turn-instruction';
    const summary = document.createElement('summary');
    summary.textContent = 'Vitals instruction for this reply';
    const note = document.createElement('p');
    note.textContent = opts.instruction || 'No vitals instruction for this turn.';
    details.append(summary, note);
    el.appendChild(details);
  }
  const stick = who === 'user' || follow;
  $('log').appendChild(el);
  if (stick) scrollToLatest(); else $('jumpLatest').hidden = false;
  return el;
}
async function poll() {
  try {
    const s = await api('/api/state');
    const c = s.consent || {};
    consent = !!c.sensing;
    sensingInfo = s.sensing || {};
    const st = s.state || 'starting';
    $('incognito').checked = !c.memory;
    $('aiNote').hidden = !consent || !!c.aiSharing;
    $('hint').hidden = !(s.sensing && s.sensing.simulated);
    $('sensorError').hidden = !(s.sensing && s.sensing.error);
    if (s.sensing && s.sensing.error) $('sensorError').textContent = `Sensor could not start: ${s.sensing.error}`;
    $('state').textContent = LABEL[st] || st;
    $('mascot').dataset.state = st;
    $('pulse').textContent = s.pulseBpm == null ? '—' : s.pulseBpm;
    $('confLabel').textContent = !consent ? 'tap to begin' : st === 'standby' ? 'turns on when you chat' : st === 'paused' ? 'camera paused' : st === 'starting' ? 'starting…' : st === 'calibrating' ? 'calibrating…' : st === 'unclear' ? 'signal low' : 'signal ' + Math.round((s.confidence || 0) * 100) + '%';
    renderSignals(s.signals);
    proposeMood(moodFor(s));
    const active = s.sensing && s.sensing.state === 'active';
    const errored = s.sensing && s.sensing.state === 'error';
    let instruction = s.vitalsInstruction;
    if (!instruction) {
      if (!c.sensing) instruction = 'Camera sensing is off. The companion has no vitals instruction.';
      else if (!c.aiSharing) instruction = 'AI sharing is off. Your readings stay out of the companion prompt.';
      else if (s.sensing.paused) instruction = 'Camera paused. No current vitals instruction.';
      else if (errored) instruction = 'Camera unavailable. No current vitals instruction.';
      else if (!active) instruction = 'Waiting for the camera to start.';
      else instruction = 'Waiting for a fresh reading.';
    }
    if ($('vitalsInstruction').textContent !== instruction) $('vitalsInstruction').textContent = instruction;
    $('fullVitals').textContent = instruction;
    const preview = $('vitalsInstruction');
    $('readInstruction').hidden = preview.scrollHeight <= preview.clientHeight + 1;
    renderCamera(s, c, active, errored);
    renderSetupCam(s);
    if (s.lensMode && s.lensMode !== lensMode && !modeBusy) { lensMode = s.lensMode; renderModeSeg(); syncPacer(); }
    renderMeasuredBreath(s.signals, active, s.breath);
    $('insightBox').hidden = !active;
    if (s.insight) {
      if ($('insightText').textContent !== s.insight.text) $('insightText').textContent = s.insight.text;
      $('insightMeta').textContent = `${s.insight.origin} · ${new Date(s.insight.receivedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const show = consent && s.say && s.directive;
    $('nudgeBox').hidden = !show;
    if (show) { $('directive').textContent = s.directive; $('evidence').textContent = (s.evidence || []).join(' · '); }
    updateSlot();
    if (s.ai) renderAi(s.ai);
    lastState = s;
    document.dispatchEvent(new CustomEvent('attune-guidance', { detail: s.vitalsInstruction || '' }));
  } catch (e) {
    document.dispatchEvent(new CustomEvent('attune-guidance', { detail: '' }));
    $('vitalsInstruction').textContent = 'Current vitals instruction unavailable.';
    if (!(e instanceof TypeError && /fetch/i.test(e.message)) && !/stale session token/.test(e.message)) console.error('poll failed:', e);
  }
}
/* ---------- Chat scrolling ---------- */
// "follow" = keep the newest message in view. Only the person scrolling up turns it off; our own smooth
// scrolling (still in flight when a reply arrives) must not.
let follow = true, autoScrolling = false, autoTimer = null;
function nearBottom() { const v = $('log'); return v.scrollHeight - v.scrollTop - v.clientHeight < 80; }
function scrollToLatest() {
  follow = true;
  autoScrolling = true;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { autoScrolling = false; }, 800);
  $('log').scrollTo({ top: $('log').scrollHeight, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  $('jumpLatest').hidden = true;
}
$('log').addEventListener('scroll', () => {
  if (nearBottom()) { follow = true; $('jumpLatest').hidden = true; }
  else if (!autoScrolling) follow = false;
}, { passive: true });
$('jumpLatest').onclick = scrollToLatest;

/* ---------- AI status ---------- */
function renderAi(ai) {
  const problem = ai.mode !== 'demo' && !ai.connected;
  const t = problem ? 'Text chat offline' : '';
  if ($('aiStatus').textContent !== t) $('aiStatus').textContent = t;
  $('aiStatus').hidden = !problem;
  $('aiStatus').classList.toggle('bad', problem);
  $('newChat').title = ai.mode === 'demo' ? 'Start a new conversation (demo: scripted replies)' : `Start a new conversation · ${ai.provider} · ${ai.model}`;
  $('aiDisclosure').hidden = ai.mode === 'demo';
}
$('newChat').onclick = async () => {
  await api('/api/chat/reset', {});
  $('log').replaceChildren();
  addMsg("New conversation. What's on your mind?", 'bot');
};

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
$('consentCancel').onclick = () => { $('consentDlg').hidden = true; rememberAsked(); afterConsentDialog(); };
$('consentStart').onclick = async () => {
  const r = await api('/api/consent', { sensing: true, presageAck: true, aiSharing: $('cAi').checked, memory: $('cMemory').checked });
  if (r.error) { $('consentErr').textContent = r.error; $('consentErr').hidden = false; return; }
  $('consentDlg').hidden = true;
  rememberAsked();
  await poll();
  afterConsentDialog();
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('consentDlg').hidden) { $('consentDlg').hidden = true; afterConsentDialog(); }
  else if (!$('setupDlg').hidden) closeSetup();
});
/* ---------- Camera button: allow / pause / resume / turn on now ---------- */
let sensingInfo = {};
function cameraAction() {
  if (!consent) return 'allow';
  if (sensingInfo.state === 'active' || sensingInfo.state === 'starting') return 'pause';
  if (sensingInfo.paused) return 'resume';
  return 'start';
}
const CAM_BUTTON = {
  allow: ['Allow camera sensing', 'consent'],
  pause: ['Camera on — tap to pause', 'pause'],
  resume: ['Paused — tap to resume', 'consent'],
  start: ['Camera off — turn on now', 'consent'],
};
// Plain-language hints for the camera's positioning checks (SmartSpectra validation codes).
const CAM_HINTS = { 1: 'Looking for your face…', 2: 'Only one face, please.', 3: 'Center your face in the camera.', 5: 'It is a bit dark — add some light.',
  6: 'Too bright — reduce glare.', 7: 'Sit back a little so your chest is visible too.', 10: 'Adjusting the camera…', 11: 'Camera is slow — close other camera apps.',
  12: 'Try to hold still for a moment.', 13: 'Move back a little.', 14: 'Move a little closer.', 15: 'Move down, or tilt the camera up.',
  16: 'Move up, or tilt the camera down.', 17: 'Face the camera.' };
function renderCamera(s, c, active, errored) {
  const action = errored ? 'start' : cameraAction();
  const [label, iconId] = errored ? ['Sensor stopped — tap to retry', 'refresh'] : CAM_BUTTON[action];
  if ($('consentLabel').textContent !== label) $('consentLabel').textContent = label;
  const iconHref = `assets/icons.svg#i-${iconId}`;
  if ($('consentIcon').getAttribute('href') !== iconHref) $('consentIcon').setAttribute('href', iconHref);
  $('consentBtn').classList.toggle('on', action === 'pause');
  $('forgetConsent').hidden = !c.sensing;
  $('camPill').hidden = !active;
  const cam = (s.sensing && s.sensing.camera) || {};
  let hint = '';
  if (active && cam.validationCode) hint = CAM_HINTS[cam.validationCode] || cam.hint || '';
  else if (active && cam.processing === 'starting') hint = 'Getting a clear view…';
  if (active && cam.mode === 'face') hint = hint || 'Face-only mode: no breathing or Presage check-ins.';
  if ($('camHint').textContent !== hint) $('camHint').textContent = hint;
  $('camHint').hidden = !hint;
  const idleMin = s.sensing && s.sensing.idleInMs != null ? Math.ceil(s.sensing.idleInMs / 60000) : null;
  $('policyNote').textContent = !c.sensing
    ? 'Only interpreted signals — never raw video or vitals — are shared, and only after you consent.'
    : active ? `The camera turns off after ${idleMin || 5} min without chatting. Only interpreted signals are shared.`
      : s.sensing && s.sensing.paused ? 'Camera paused. It stays off — even when you chat — until you resume.'
        : 'Permission remembered. The camera turns on when a chat starts or the AI asks.';
}
$('consentBtn').onclick = async () => {
  const action = sensingInfo.state === 'error' ? 'start' : cameraAction();
  if (action === 'allow') return openConsent();
  await api('/api/sensing', { action });
  poll();
};
$('forgetConsent').onclick = async () => {
  await api('/api/revoke', {});
  try { localStorage.removeItem('attune_consent_asked'); } catch {}
  poll();
};
// Ask once: the first chat message opens the dialog if the person has never answered it.
function askedBefore() { try { return localStorage.getItem('attune_consent_asked') === '1'; } catch { return false; } }
function rememberAsked() { try { localStorage.setItem('attune_consent_asked', '1'); } catch {} }
$('chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('msg').value.trim(); if (!text) return;
  $('msg').value = ''; addMsg(text, 'user');
  if (!consent && !askedBefore()) openConsent();
  $('msg').disabled = true;
  let r;
  try { r = await api('/api/chat', { message: text }); } catch { r = { error: 'offline', errorText: "Can't reach Attune's local server." }; }
  $('msg').disabled = false; $('msg').focus();
  if (r.error) addMsg(r.errorText || 'The AI could not reply.', 'sys');
  else addMsg(r.reply, 'bot', { by: r.usedBody, instruction: r.vitalsInstruction });
  if (r.ai) renderAi(r.ai);
  if (lastState) proposeMood(moodFor({ ...lastState, state: r.state || lastState.state }), true);
};

/* ---------- API keys and optional camera check ---------- */
let setup = {}, setupStep = 0, setupWaitingConsent = false;
const keyRoutes = { camera: '/api/setup/key', groq: '/api/setup/groq', openai: '/api/setup/openai' };
async function loadSetup(firstRun = false) {
  const r = await api('/api/setup/keys');
  if (typeof r.desktop !== 'boolean') throw new Error('Could not read key settings.');
  setup = r;
  $('keyHelp').textContent = r.desktop
    ? 'Add your own keys for the features you want. Keys are encrypted for your computer account. Demo mode needs no keys.'
    : 'For encrypted key management, run npm start from the checkout. The web-only service reads SMARTSPECTRA_API_KEY, GROQ_API_KEY and OPENAI_API_KEY from its environment.';
  for (const id of Object.keys(keyRoutes)) {
    const saved = { camera: !r.needsKey, groq: r.hasGroq, openai: r.hasOpenAI }[id];
    $(id + 'Input').disabled = !r.desktop;
    $(id + 'Save').hidden = !r.desktop;
    $(id + 'Remove').hidden = !r.desktop || !saved;
    $(id + 'Status').textContent = saved ? 'Configured' : 'No key added';
  }
  $('cameraCheck').hidden = r.needsKey && !r.demo;
  if (firstRun && r.desktop && !r.demo && (r.needsKey || !r.hasGroq || !r.hasOpenAI)) {
    let prompted = false;
    try { prompted = !!localStorage.getItem('attune_keys_intro'); localStorage.setItem('attune_keys_intro', '1'); } catch {}
    if (!prompted) switchView('keys');
  }
}
for (const [id, route] of Object.entries(keyRoutes)) {
  const input = $(id + 'Input'), save = $(id + 'Save'), remove = $(id + 'Remove');
  input.oninput = () => { save.disabled = !input.value.trim(); };
  async function update(clear) {
    input.disabled = save.disabled = remove.disabled = true;
    try {
      const result = await api(clear ? route + '/clear' : route, clear ? {} : { key: input.value.trim() });
      if (!result.ok) throw new Error(result.error || 'Could not update the key.');
      input.value = '';
      await loadSetup();
    } catch (error) { $(id + 'Status').textContent = error.message; }
    finally { input.disabled = remove.disabled = false; save.disabled = !input.value.trim(); }
  }
  $(id + 'Form').onsubmit = (event) => { event.preventDefault(); if (!save.disabled) update(false); };
  remove.onclick = () => { if (confirm('Remove the saved ' + ({ camera: 'SmartSpectra', groq: 'Groq', openai: 'OpenAI' }[id]) + ' key?')) update(true); };
}
$('keysLater').onclick = () => switchView('home');
$('cameraCheck').onclick = () => { $('setupDlg').hidden = false; showSetupStep(2); };
function showSetupStep(n) {
  setupStep = n;
  for (const step of [2, 3]) $('setupStep' + step).hidden = n !== step;
  if (n === 2 && lastState) renderSetupCam(lastState);
  $('setupStep' + n).querySelector('h2').focus();
}
function closeSetup() { $('setupDlg').hidden = true; setupStep = 0; }
$('setupLater').onclick = closeSetup;
$('setupNext').onclick = () => showSetupStep(3);
$('setupDone').onclick = closeSetup;
$('setupConnectors').onclick = () => { closeSetup(); switchView('connectors'); };
// Step 2 uses the normal consent dialog: setup steps aside while it is open and comes back afterwards.
$('setupCamBtn').onclick = async () => {
  if (!consent) { setupWaitingConsent = true; $('setupDlg').hidden = true; openConsent(); return; }
  try { await api('/api/sensing', { action: 'start' }); } catch {}
  poll();
};
function afterConsentDialog() {
  if (!setupWaitingConsent) return;
  setupWaitingConsent = false;
  $('setupDlg').hidden = false;
  showSetupStep(2);
}
function renderSetupCam(s) {
  if (setupStep !== 2) return;
  const sens = s.sensing || {}, cam = sens.camera || {};
  const allowed = !!(s.consent && s.consent.sensing);
  const active = sens.state === 'active';
  const found = active && cam.validationCode === 0; // "validation ok": SmartSpectra sees one face
  let text;
  if (sens.state === 'error') text = `The camera could not start: ${sens.error || 'unknown error'}`;
  else if (!allowed) text = 'The camera is off.';
  else if (sens.paused) text = 'The camera is paused.';
  else if (sens.state === 'starting') text = 'Starting the camera…';
  else if (!active) text = 'The camera is off.';
  else if (setup.demo) text = 'Demo camera check complete with synthetic readings.';
  else if (found) text = 'Face found — you are all set.';
  else text = CAM_HINTS[cam.validationCode] || cam.hint || (cam.processing === 'starting' ? 'Getting a clear view…' : 'Looking for your face…');
  if ($('setupCamText').textContent !== text) $('setupCamText').textContent = text;
  $('setupCam').classList.toggle('found', found);
  const href = `assets/icons.svg#i-${found ? 'check' : 'face'}`;
  if ($('setupCamIcon').getAttribute('href') !== href) $('setupCamIcon').setAttribute('href', href);
  $('setupCamBtn').hidden = active || sens.state === 'starting';
  $('setupCamLabel').textContent = !allowed ? 'Allow the camera' : sens.state === 'error' ? 'Try again' : 'Turn the camera on';
  $('setupNext').hidden = !(found || (setup.demo && active));
}

/* Camera key row (sidebar, desktop app only): replace or remove the saved key. */
/* ---------- boot ---------- */
scrollArea($('logHost'), $('log'));
scrollArea(document.querySelector('#consentDlg .dlg'));
scrollArea(document.querySelector('#setupDlg .dlg'));
scrollArea($('dayDetail'));
setTimeout(() => $('mascot').classList.remove('greeting'), 2400); // hello wave, then settle to idle
setInterval(poll, 400); poll();
loadLenses().then(() => refreshApps(true));
loadSetup(true).catch(() => { $('keyHelp').textContent = 'Could not load key settings. Reload Attune to try again.'; });
// Requests made by an AI show up (badge + card) without a reload; the activity list refreshes while it is open.
setInterval(() => { refreshApps(); if (currentView === 'activity') loadActivity(); }, 4000);
scrollArea($('actHost'), $('actList'));
addMsg("Hi — I'm here with you. If you turn on sensing (and choose to share it with me), I'll pay attention to how you're doing, not just what you say.", 'bot');
