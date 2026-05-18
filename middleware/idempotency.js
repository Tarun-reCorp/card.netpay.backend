const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');

// Replay-safe wrapper for mutating /api/cards/* endpoints.
//
// Contract:
//   - Caller MAY supply `Idempotency-Key` (header, max 200 chars).
//   - If absent, the request is passed through unchanged (back-compat).
//   - If present:
//       * First call: a "pending" record is atomically claimed via the
//         unique (apiKeyHash, key) index. Handler runs, response is captured
//         and stored.
//       * Retry with same key + same payload: the stored response is replayed
//         exactly (status code + body).
//       * Retry with same key + different payload: 409 conflict.
//   - TTL on the record collection auto-expires entries after 24h.
//
// Why this exists:
//   Without this, every merchant retry on /api/cards/:cardId/load (or /issue,
//   /unload, /freeze, /terminate) generates a fresh internal x-idempotency-key
//   and bills UQPay a second time. A single network timeout = $X double-charge.

const TTL_HOURS = 24;
const KEY_MAX_LEN = 200;

function hashKey(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}

function payloadHash(req) {
  const body = req.body ? JSON.stringify(req.body) : '';
  return crypto.createHash('sha256')
    .update(req.method + '|' + req.originalUrl + '|' + body)
    .digest('hex');
}

async function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    // Back-compat: no key supplied, pass through. Strongly recommend callers
    // start sending one; future versions may require it.
    return next();
  }
  const key = rawKey.trim();
  if (key.length > KEY_MAX_LEN) {
    return res.status(400).json({ success: false, message: 'Idempotency-Key exceeds 200 chars' });
  }

  const apiKeyHash = hashKey(req.headers['x-api-key'] || '');
  const phash      = payloadHash(req);
  const expiresAt  = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

  // Try to atomically CLAIM the key. If another request already claimed it,
  // findOneAndUpdate with upsert+conflict will fall through to lookup.
  let record;
  try {
    record = await IdempotencyRecord.findOneAndUpdate(
      { apiKeyHash, key },
      {
        $setOnInsert: {
          apiKeyHash, key,
          method: req.method, path: req.originalUrl,
          payloadHash: phash,
          inFlight: true,
          expiresAt,
        },
      },
      { upsert: true, new: false, setDefaultsOnInsert: true },
    );
  } catch (e) {
    if (e && e.code === 11000) {
      record = await IdempotencyRecord.findOne({ apiKeyHash, key });
    } else {
      console.error('[idempotency] claim failed:', e.message);
      return next(); // fail-open: don't block traffic on infra hiccup
    }
  }

  // First time we've seen this key: record is null (upsert created it but
  // returned the pre-image, which was nothing). Proceed with the handler
  // and capture the response on the way out.
  if (!record) {
    return captureResponse(req, res, next, { apiKeyHash, key });
  }

  // Same key seen before. Compare payload hash.
  if (record.payloadHash !== phash) {
    return res.status(409).json({
      success: false,
      message: 'Idempotency-Key reused with a different payload.',
    });
  }

  // Still in flight from a previous concurrent request — return 409 so the
  // client can retry after the original finishes (avoid two parallel UQPay
  // calls for the same key).
  if (record.inFlight) {
    return res.status(409).json({
      success: false,
      message: 'A previous request with this Idempotency-Key is still being processed.',
    });
  }

  // Replay the stored response verbatim.
  try {
    const body = record.responseBody ? JSON.parse(record.responseBody) : null;
    return res.status(record.responseStatus || 200).json(body);
  } catch {
    return res.status(record.responseStatus || 200).send(record.responseBody || '');
  }
}

function captureResponse(req, res, next, { apiKeyHash, key }) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    // Persist captured response asynchronously; never block the user request.
    IdempotencyRecord.findOneAndUpdate(
      { apiKeyHash, key },
      {
        $set: {
          inFlight: false,
          responseStatus: res.statusCode || 200,
          responseBody: JSON.stringify(body),
        },
      },
    ).catch(e => console.error('[idempotency] persist failed:', e.message));
    return origJson(body);
  };
  next();
}

module.exports = idempotency;
