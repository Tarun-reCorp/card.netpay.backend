const mongoose = require('mongoose');
const { Schema } = mongoose;

// Admin role tiers — used by requireRole(...) middleware to gate privileged
// endpoints. Existing rows default to 'super' (omnipotent) so a migration is
// not required, but new admins should be created with the least-privilege
// role that fits their job.
//   super   — everything (incl. balance mint, impersonation, 2FA toggle on peers)
//   ops     — deposit/withdraw approve/reject, KYC, balance adjustments, merchant + user management
//   support — read-only + user profile edits (no money moves, no impersonation)
//   auditor — read-only across the board
const ADMIN_ROLES = ['super', 'ops', 'support', 'auditor'];

const adminUserSchema = new Schema({
  name:               { type: String, required: true },
  email:              { type: String, required: true, unique: true, lowercase: true },
  password:           { type: String, required: true },
  role:               { type: String, enum: ADMIN_ROLES, default: 'super', required: true },
  isActive:           { type: Boolean, default: true },
  twoFactorSecret:    { type: String, default: null },
  twoFactorEnabled:   { type: Boolean, default: false },
  twoFactorRequired:  { type: Boolean, default: false },
}, { timestamps: true, collection: 'admin_users' });

module.exports = mongoose.model('AdminUser', adminUserSchema);
module.exports.ADMIN_ROLES = ADMIN_ROLES;
