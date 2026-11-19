'use strict';
/*
 * Lens registry. The sensing core produces one neutral snapshot; a lens turns it into feedback for one kind of
 * task (companion, yoga, …) and decides what that task is allowed to see. Apps are approved per lens
 * (src/privacy/appApprovals.js); an AI can suggest a purpose but never approve one.
 *
 * Lens contract (every module in this folder):
 *   id            string, stable, lowercase ('companion')
 *   name          human label ('Emotional companion')
 *   description   one sentence shown in the approval UI
 *   needs         signals it relies on: subset of ['pulse','expression','talking','breathing','hrv']
 *   sharesNumbers whether its output may contain measurements (shown to the person before approval)
 *   render(snapshot, extras) → AI-facing object. Must include { state, say, directive, confidence }.
 *     snapshot: neutral, internal-only (see session.getNeutralSnapshot). Never forward it as-is.
 *     extras:   { note } — optional sanitized Presage check-in note (companion-style lenses may use it).
 */

const LENSES = new Map();

function register(lens) {
  for (const k of ['id', 'name', 'description', 'render']) if (!lens[k]) throw new Error(`lens missing ${k}`);
  LENSES.set(lens.id, Object.freeze({ needs: [], sharesNumbers: false, ...lens }));
}

register(require('./companion'));

const getLens = (id) => LENSES.get(String(id || '').toLowerCase()) || null;

/** Public descriptions for UIs and tool schemas (no render functions). */
function listLenses() {
  return [...LENSES.values()].map(({ id, name, description, needs, sharesNumbers }) => ({ id, name, description, needs, sharesNumbers }));
}

module.exports = { getLens, listLenses, register, DEFAULT_LENS: 'companion' };
