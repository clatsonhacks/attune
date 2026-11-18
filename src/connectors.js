'use strict';
/*
 * Real connector status (replaces the old demo toggles). Read-only: looks at the Claude Desktop config on
 * this machine to report whether the attune-sense MCP connector is registered and with which consent.
 * Attune never edits that file; the person adds the snippet themselves.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseConsentString } = require('./privacy/consent');

const SERVER_JS = path.resolve(__dirname, 'server.js');
const DEFAULT_CONSENT = 'sensing,presage-ack,ai-sharing';

function claudeDesktopConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function snippet() {
  return JSON.stringify({ mcpServers: { 'attune-sense': { command: 'node', args: [SERVER_JS], env: { ATTUNE_CONSENT: DEFAULT_CONSENT } } } }, null, 2);
}

/** Status of the Claude Desktop registration. Never returns other servers' settings or secrets. */
function claudeDesktopStatus(configPath = claudeDesktopConfigPath()) {
  const base = { id: 'claude-desktop', name: 'Claude Desktop', configPath, snippet: snippet() };
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return { ...base, status: 'no_config', registered: false }; }
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return { ...base, status: 'unreadable', registered: false }; }
  const servers = (cfg && cfg.mcpServers) || {};
  const entry = Object.entries(servers).find(([name, s]) =>
    name === 'attune-sense' || (s && Array.isArray(s.args) && s.args.some((a) => path.basename(String(a)) === 'server.js' && String(a).includes('attune')))) || null;
  if (!entry) return { ...base, status: 'not_registered', registered: false };
  const [name, s] = entry;
  const consent = parseConsentString(s.env && s.env.ATTUNE_CONSENT);
  const pointsHere = Array.isArray(s.args) && s.args.some((a) => path.resolve(String(a)) === SERVER_JS);
  return {
    ...base,
    status: 'registered',
    registered: true,
    serverName: name,
    pointsToThisInstall: pointsHere,
    consent: { sensing: consent.sensing && consent.presageAck, aiSharing: consent.aiSharing, memory: consent.memory },
  };
}

function connectorsStatus() {
  return {
    connectors: [
      claudeDesktopStatus(),
      { id: 'chatgpt', name: 'ChatGPT', status: 'not_supported', registered: false,
        note: 'ChatGPT needs a remote MCP connection with a pairing flow. Not built yet (plan M6-05).' },
    ],
  };
}

module.exports = { connectorsStatus, claudeDesktopStatus, claudeDesktopConfigPath, snippet, SERVER_JS };
