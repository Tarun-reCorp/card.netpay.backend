const AuditLog = require('../models/AuditLog');

// Single helper for writing audit rows. Always non-throwing — audit must
// never break the user request even if the log collection is briefly
// unavailable. Captures actor + target + payload + request fingerprint.
//
// Usage from controllers (after adminAuthMiddleware ran):
//   writeAudit(req, {
//     action: 'wallet.credit',
//     targetType: 'User',
//     targetId: req.params.id,
//     payload: { amount, notes },
//   });
//
// For non-admin-driven actions, pass actorType explicitly.

async function writeAudit(req, opts = {}) {
  try {
    const {
      action, targetType = null, targetId = null,
      payload = null, success = true, errorMessage = null,
    } = opts;

    if (!action) return;

    // Identify the actor from whichever auth middleware ran.
    let actorType = opts.actorType || 'system';
    let actorId   = null;
    let actorEmail = null;
    let actorRole  = null;
    let impersonatedBy = null;

    if (req?.admin) {
      actorType = 'admin';
      actorId   = req.admin._id;
      actorEmail = req.admin.email || null;
      actorRole  = req.admin.role || null;
    } else if (req?.merchant) {
      actorType = 'merchant';
      actorId   = req.merchant._id;
      actorEmail = req.merchant.email || null;
    } else if (req?.user) {
      actorType = 'user';
      actorId   = req.user._id;
      actorEmail = req.user.email || null;
      // If the auth middleware exposed an impersonation actor (admin who
      // opened a loginAs session), capture it so the chain is visible.
      if (req.impersonatedBy) impersonatedBy = req.impersonatedBy;
    }

    await AuditLog.create({
      actorType, actorId, actorEmail, actorRole, impersonatedBy,
      action, targetType, targetId,
      payload,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      userAgent: req?.headers?.['user-agent'] || null,
      success, errorMessage,
    });
  } catch (e) {
    // Never let audit failure surface to the caller. Log loudly so an
    // operator can investigate broken pipelines.
    console.error('[audit] write failed action=%s err=%s', opts?.action, e.message);
  }
}

module.exports = { writeAudit };
