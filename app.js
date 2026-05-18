require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/database');
const routes = require('./routes');
const sanitizeMongo = require('./middleware/sanitizeMongo');
const { globalLimiter } = require('./middleware/rateLimiters');
const { buildCorsOptions } = require('./middleware/corsOptions');

const app = express();

// Behind a reverse proxy (Nginx/ALB/Cloudflare) req.ip would otherwise be the
// proxy IP and per-IP rate limiting would lump every client together. Trust
// the first hop only — never blindly trust the full X-Forwarded-For chain.
app.set('trust proxy', 1);

connectDB();

// Security headers. Helmet ships sensible defaults for X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, X-DNS-Prefetch-Control, etc.
// HSTS forces TLS for a year once the browser sees it. CSP is left to a
// permissive default because this service is a JSON API (no HTML rendered
// here) — tighten on the frontend host instead.
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: false,         // API server, not an HTML host
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow merchant API consumers
}));

app.use(cors(buildCorsOptions()));
// Explicit body-size caps. Defaults are 100kb already but stating them
// makes it impossible for a future config drift to allow JSON bombs.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
// Strip MongoDB query-operator keys ($ne, $gt, …) and dotted paths from any
// caller-supplied input so a body like { email: { $ne: null } } cannot bypass
// equality checks in controllers that do User.findOne({ email: req.body.email }).
app.use(sanitizeMongo);
// Global per-IP rate limit. Tight per-route limiters are layered on top inside
// each router (login, 2FA verify, forgot-password, /api/cards/*).
app.use(globalLimiter);
app.use('/uploads', express.static('uploads'));

app.use('/api', routes);

app.get('/', (req, res) => {
  res.send('Welcome to the NetpayCard API');
});

app.use((err, req, res, next) => {
  // Body-parser errors carry useful diagnostics; everything else is logged
  // server-side and returned as a generic 500 so we never leak schema /
  // stack details to the network.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body too large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON body' });
  }
  console.error('[errorHandler]', err && err.stack ? err.stack : err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
