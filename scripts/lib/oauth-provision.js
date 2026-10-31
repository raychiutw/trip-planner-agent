'use strict';
/**
 * oauth-provision.js — shared client_app provisioning primitives (secret gen +
 * PBKDF2 hash), so provisioning scripts don't each re-implement them.
 *
 * NOTE: provision-admin-cli-client.js still carries its own inline copies (it is
 * a prod incident-recovery tool that runs against the live token client — not
 * refactored here to avoid touching it without a way to run-verify). New scripts
 * should import from this module; migrating the admin script is a deferred TODO.
 */
const crypto = require('crypto');

/** base32 secret with tps_ prefix — matches /api/dev/apps + provision-admin-cli-client.js. */
function generateClientSecret() {
  const bytes = crypto.randomBytes(32);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return `tps_${result}`;
}

/**
 * PBKDF2-SHA256. MUST stay in sync with `ITERATIONS` in src/server/password.ts —
 * verifyPassword on prod reads iter from the stored hash and runs that many
 * iterations; iter above the CF Workers CPU ceiling would make login exceed budget.
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const iter = 100_000; // keep in sync with src/server/password.ts ITERATIONS
  const hash = crypto.pbkdf2Sync(plain, salt, iter, 32, 'sha256');
  const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `pbkdf2$${iter}$${b64u(salt)}$${b64u(hash)}`;
}

module.exports = { generateClientSecret, hashPassword };
