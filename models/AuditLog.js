const mongoose = require('mongoose');
const { Schema } = mongoose;

// Tamper-evident record of every privileged action taken in the platform.
// Required by PCI-DSS Req 10.2 and SOC2 audit trail controls.
//
// What gets written:
//   - All admin actions that mutate money, KYC, 2FA, role, impersonation,
//     commission settings, merchant/user lifecycle.
//   - Impersonation chains: when an admin opens a session as a user via
//     loginAsUser, the user-side JWT carries actorAdminId so subsequent
//     financial actions taken under that session record the originating admin.
//
// What does NOT belong here:
//   - High-volume read traffic (GET /admin/users etc.) — those are noise.
//   - Anything containing PAN/CVV/PIN or full passwords.

const auditLogSchema = new Schema({
  // Who took the action.
  actorType:   { type: String, enum: ['admin', 'merchant', 'user', 'system'], required: true },
  actorId:     { type: Schema.Types.ObjectId, default: null },
  actorEmail:  { type: String, default: null },
  actorRole:   { type: String, default: null },             // for admin actors
  // If this was an impersonation session, the admin who initiated it.
  impersonatedBy: { type: Schema.Types.ObjectId, default: null },

  // What was done.
  action:      { type: String, required: true, index: true }, // e.g. 'wallet.credit', 'withdrawal.approve'

  // What it was done to.
  targetType:  { type: String, default: null }, // 'User', 'Merchant', 'Withdrawal', etc.
  targetId:    { type: Schema.Types.ObjectId, default: null },

  // Free-form structured context (amount, status transitions, reason, etc.)
  payload:     { type: Schema.Types.Mixed, default: null },

  // Request fingerprint for forensics.
  ip:          { type: String, default: null },
  userAgent:   { type: String, default: null },

  // Outcome.
  success:     { type: Boolean, default: true },
  errorMessage:{ type: String, default: null },
}, { timestamps: true, collection: 'audit_logs' });

auditLogSchema.index({ actorType: 1, actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
