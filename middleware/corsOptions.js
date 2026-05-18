// CORS allowlist driven by the CORS_ALLOWED_ORIGINS env var (comma-separated).
//
// Example .env:
//   CORS_ALLOWED_ORIGINS=https://app.netpay.com,https://admin.netpay.com,http://localhost:5173
//
// Behaviour:
//   - Requests with no Origin header (server-to-server, curl, Postman) are
//     allowed unchanged. Browser-driven cross-origin requests check the list.
//   - Wildcard "*" is only honored in development to keep dev mode painless.
//     In production, an empty allowlist blocks every cross-origin browser
//     request — set the env var before deploying.
//   - Credentials (cookies, Authorization headers) are explicitly allowed
//     so the frontend's Bearer token works against the configured origins.
//
// Why we did not use cors() defaults:
//   The default Access-Control-Allow-Origin: * reflects every request and
//   forbids credentials. The frontend already sends Authorization headers,
//   so we need an exact-origin echo with credentials:true. Wide-open `*`
//   also amplifies any future XSS by letting any page drive the API.

function parseAllowList() {
  const raw = process.env.CORS_ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Matches any http://localhost:* or http://127.0.0.1:* or http://[::1]:*
// Allowed only when NODE_ENV !== 'production' so developers do not have to
// edit .env every time they switch Vite ports.
const DEV_LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function buildCorsOptions() {
  const allowList = parseAllowList();
  const isDev = process.env.NODE_ENV !== 'production';

  return {
    origin(origin, callback) {
      // Same-origin / non-browser callers (no Origin header).
      if (!origin) return callback(null, true);

      // Explicit allowlist match.
      if (allowList.includes(origin)) return callback(null, true);

      // Dev convenience: any localhost origin passes without env config.
      if (isDev && DEV_LOCAL_RE.test(origin)) return callback(null, true);

      // Wildcard accepted only in non-production environments.
      if (isDev && allowList.includes('*')) return callback(null, true);

      // Otherwise refuse — but do it cleanly with `false` so the cors
      // package returns a regular CORS-blocked response instead of
      // throwing into the global error handler.
      console.warn('[cors] blocked origin=%s allowList=%j', origin, allowList);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'Idempotency-Key',
      'X-Idempotency-Key',
    ],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 600,
  };
}

module.exports = { buildCorsOptions };
