const crypto = require('crypto');

// Constant-time API-key check. `===` short-circuits on first byte mismatch and
// in principle leaks the key byte-by-byte via response-time deltas (slow over
// WAN but free to defend against). `crypto.timingSafeEqual` runs in O(n) of
// the longer buffer regardless of mismatch position.
//
// The reject path is also unified to a single message+status to avoid leaking
// "key present but wrong" vs "no key at all".
const apiKeyMiddleware = (req, res, next) => {
  const supplied = req.headers['x-api-key'];
  const expected = process.env.API_KEY;

  // If the server has no API_KEY configured, refuse every request — never
  // silently allow blank-vs-blank to authenticate.
  if (!expected || typeof expected !== 'string') {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }
  if (typeof supplied !== 'string' || supplied.length === 0) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }
  next();
};

module.exports = apiKeyMiddleware;
