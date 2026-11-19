'use strict';
/*
 * Remembered consent. The person is asked once; their choices are stored on this computer
 * (consent.json in the per-user data folder, see src/paths.js) and restored at start-up. Restoring gives PERMISSION only —
 * the camera still starts only when a chat starts or the AI asks (see webServer's sensing policy).
 *
 * DISCLOSURE_VERSION must be bumped whenever the consent dialog's disclosures change in substance;
 * a stored consent for an older version is ignored, so the person is asked again.
 */
const fs = require('fs');
const path = require('path');
const { storeFile } = require('../paths');

const DISCLOSURE_VERSION = 2; // v2: camera turns on automatically when a chat starts or the AI asks

function createConsentStore(filePath) {
  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!d || d.version !== DISCLOSURE_VERSION || !d.scopes) return null;
      const s = d.scopes;
      return {
        scopes: { sensing: !!s.sensing, presageAck: !!s.presageAck, aiSharing: !!s.aiSharing, memory: !!s.memory },
        paused: !!d.paused,
        grantedAt: d.grantedAt || null,
      };
    } catch {
      return null;
    }
  }

  function save({ scopes, paused = false, grantedAt }) {
    const data = {
      version: DISCLOSURE_VERSION,
      grantedAt: grantedAt || new Date().toISOString(),
      paused: !!paused,
      scopes: { sensing: !!scopes.sensing, presageAck: !!scopes.presageAck, aiSharing: !!scopes.aiSharing, memory: !!scopes.memory },
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return data;
  }

  function clear() {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return { load, save, clear };
}

/** Consent file in the per-user data folder (demo mode keeps its own). */
const defaultConsentFile = (demo = false, env = process.env) => storeFile('consent', { demo, env });

module.exports = { createConsentStore, defaultConsentFile, DISCLOSURE_VERSION };
