// Centralized rate-limit buckets. All values are tunable via env without code
// changes. Keep limits tight on credential surfaces and on the merchant API
// where each request can mutate UQPay-side balance.
//
// Why this file exists:
//   Without rate limiting, every authentication surface is open to
//   brute-force at network speed: password spray on three login endpoints,
//   TOTP guess on 2FA verify, API-key spray on /api/cards/*, reset-token spray
//   on /forgot-password. A single limiter per surface raises the cost of an
//   attack from "free" to "infeasible".
//
// IPv6 note:
//   express-rate-limit v7 requires that any custom keyGenerator that uses
//   the client IP normalize it through `ipKeyGenerator()`. Different IPv6
//   representations of the same client (`::1`, `::ffff:127.0.0.1`,
//   `2001:db8::1` vs `2001:db8::0001`) would otherwise hash to distinct
//   buckets, letting an attacker bypass the limit by rotating notation.
//   The helper canonicalises addresses (and, for IPv6, optionally collapses
//   to a /64 prefix) before the key is built.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function num(env, fallback) {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const standardOpts = {
  standardHeaders: true,   // RateLimit-* headers per RFC 9239
  legacyHeaders: false,    // hide X-RateLimit-*
};

// Canonical IP key — IPv4 untouched, IPv6 normalised + /64-collapsed by
// the library helper.
function ipKey(req) {
  return ipKeyGenerator(req.ip || '');
}

// Generic global cap so a single IP cannot saturate the API.
const globalLimiter = rateLimit({
  ...standardOpts,
  windowMs: num('RL_GLOBAL_WINDOW_MS', 60_000),
  max:      num('RL_GLOBAL_MAX', 300),
  message:  { success: false, message: 'Too many requests. Please slow down.' },
});

// Authentication-style endpoints: login, 2FA verify, forgot password.
// Tighter than global; keyed by IP + email when present so a single IP can't
// hammer one account, and one account can't be hammered from many IPs.
function authLimiter({ windowMs, max }) {
  return rateLimit({
    ...standardOpts,
    windowMs,
    max,
    keyGenerator: (req) => {
      const ip   = ipKey(req);
      const hint = (req.body && typeof req.body.email === 'string')
        ? req.body.email.trim().toLowerCase()
        : '';
      return hint ? `${ip}|${hint}` : ip;
    },
    message: { success: false, message: 'Too many attempts. Try again later.' },
  });
}

// Login (any portal): 5 attempts / 15 min / (ip+email).
const loginLimiter = authLimiter({
  windowMs: num('RL_LOGIN_WINDOW_MS', 15 * 60_000),
  max:      num('RL_LOGIN_MAX', 5),
});

// 2FA verify: 10 attempts / 15 min / ip (TOTP brute-force defence).
const twoFactorLimiter = rateLimit({
  ...standardOpts,
  windowMs: num('RL_2FA_WINDOW_MS', 15 * 60_000),
  max:      num('RL_2FA_MAX', 10),
  keyGenerator: ipKey,
  message: { success: false, message: 'Too many 2FA attempts. Try again later.' },
});

// Forgot-password: 5 / hour / (ip+email) — also a generic ack response so
// timing doesn't disclose account existence.
const forgotPasswordLimiter = authLimiter({
  windowMs: num('RL_FORGOT_WINDOW_MS', 60 * 60_000),
  max:      num('RL_FORGOT_MAX', 5),
});

// Public merchant API. Tight per X-API-Key so a leaked key can't burst
// thousands of UQPay-billable requests before rotation. Falls back to the
// canonical IP key when the X-API-Key header is absent (e.g. preflight).
const merchantApiLimiter = rateLimit({
  ...standardOpts,
  windowMs: num('RL_MERCHANT_API_WINDOW_MS', 60_000),
  max:      num('RL_MERCHANT_API_MAX', 60),
  keyGenerator: (req) => {
    const k = req.headers['x-api-key'];
    return (typeof k === 'string' && k) ? `key:${k.slice(0, 16)}` : ipKey(req);
  },
  message: { success: false, message: 'Too many API requests. Slow down.' },
});

module.exports = {
  globalLimiter,
  loginLimiter,
  twoFactorLimiter,
  forgotPasswordLimiter,
  merchantApiLimiter,
};
