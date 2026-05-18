// Centralized 500-response helper.
//
// Why this exists:
//   ~126 controller catch blocks did
//     res.status(500).json({ success: false, message: err.message })
//   which leaks Mongoose schema details, ObjectId values, duplicate-key index
//   names, and bcrypt/internal error strings to the network. Every controller
//   that imports this helper instead funnels through a single function that
//   logs the full error server-side (with route + actor context) and returns
//   a generic, non-revealing body.

function actorInfo(req) {
  if (req?.admin)    return `admin:${req.admin._id}`;
  if (req?.merchant) return `merchant:${req.merchant._id}`;
  if (req?.user)     return `user:${req.user._id}`;
  return 'anon';
}

// Send a 500 response. Logs the full error (including stack) server-side and
// returns a generic body to the client.
function serverError(req, res, err, opts = {}) {
  const tag = opts.tag || (req?.originalUrl || 'unknown');
  const actor = actorInfo(req);
  // eslint-disable-next-line no-console
  console.error('[500] route=%s actor=%s err=%s', tag, actor, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  return res.status(500).json({
    success: false,
    message: opts.publicMessage || 'Internal server error',
  });
}

module.exports = { serverError };
