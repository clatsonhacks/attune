'use strict';
/*
 * Local-only HTTP guard for the demo backend.
 *
 *  - Host header must be localhost/127.0.0.1 on our port → blocks DNS-rebinding attacks.
 *  - Origin, when a browser sends one, must be our own origin → blocks cross-site requests.
 *  - Every /api call must carry the per-boot random session token (x-attune-token). The token is
 *    only delivered inside index.html, which other origins cannot read.
 */
const crypto = require('crypto');

function createLocalGuard({ port }) {
  const token = crypto.randomBytes(24).toString('hex');
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(token);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  /** Returns null when the request may proceed, else { code, error }. */
  function check(req, { requireToken }) {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return { code: 403, error: 'bad host' };
    const origin = req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) return { code: 403, error: 'bad origin' };
    if (requireToken && !safeEqual(req.headers['x-attune-token'])) return { code: 401, error: 'missing or invalid session token' };
    return null;
  }

  return { token, check };
}

module.exports = { createLocalGuard };
