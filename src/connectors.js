'use strict';
/*
 * Local Claude Desktop registration and setup details for other MCP clients.
 */
const fs = require('fs');
const { randomUUID } = require('crypto');
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

function connectorEntry(command = 'node') {
  return { command, args: [SERVER_JS], env: { ATTUNE_CONSENT: DEFAULT_CONSENT } };
}

function snippet() {
  return JSON.stringify({ mcpServers: { 'attune-sense': connectorEntry() } }, null, 2);
}

function readClaudeConfig(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, config: {} };
    throw error;
  }
  const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      ('mcpServers' in config && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error('Invalid Claude Desktop config');
  }
  return { raw, config };
}

function findAttune(servers) {
  return Object.entries(servers || {}).find(([name, entry]) =>
    name === 'attune-sense' || (entry && Array.isArray(entry.args) &&
      entry.args.some((arg) => path.basename(String(arg)) === 'server.js' && String(arg).includes('attune'))));
}

// Install only a new entry. Preserve existing settings and publish a complete file atomically.
function registerClaudeDesktop(configPath = claudeDesktopConfigPath()) {
  let current;
  try { current = readClaudeConfig(configPath); } catch {
    return { error: 'Claude Desktop configuration could not be read. Check it before trying again.' };
  }
  const { raw, config } = current;
  if (findAttune(config.mcpServers)) return { error: 'Claude Desktop already has an Attune entry. Review it in Claude Desktop.' };

  config.mcpServers = { ...config.mcpServers, 'attune-sense': connectorEntry(process.execPath) };
  const tempPath = path.join(path.dirname(configPath), '.attune-' + randomUUID() + '.tmp');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mode = raw === null ? 0o600 : fs.statSync(configPath).mode & 0o777;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', { mode, flag: 'wx' });
    if (raw === null) {
      fs.linkSync(tempPath, configPath);
    } else {
      if (fs.readFileSync(configPath, 'utf8') !== raw) return { error: 'Claude Desktop settings changed. Try again.' };
      fs.renameSync(tempPath, configPath);
    }
    return { ok: true };
  } catch {
    return { error: 'Could not save Claude Desktop settings. Quit Claude Desktop and try again.' };
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

/** Status of the Claude Desktop registration. Never returns other servers' settings or secrets. */
function claudeDesktopStatus(configPath = claudeDesktopConfigPath()) {
  const base = { id: 'claude-desktop', name: 'Claude Desktop' };
  let current;
  try { current = readClaudeConfig(configPath); } catch { return { ...base, status: 'unreadable', registered: false }; }
  if (current.raw === null) return { ...base, status: 'no_config', registered: false };
  const entry = findAttune(current.config.mcpServers);
  if (!entry) return { ...base, status: 'not_registered', registered: false };
  const [name, config] = entry;
  const s = config || {};
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
      { id: 'chatgpt', name: 'ChatGPT', command: 'node "' + SERVER_JS + '" --chatgpt' },
      { id: 'other', name: 'Other AI clients', snippet: snippet() },
    ],
  };
}

module.exports = { connectorsStatus, claudeDesktopStatus, claudeDesktopConfigPath, registerClaudeDesktop, snippet, SERVER_JS };
