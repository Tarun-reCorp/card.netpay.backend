// Single resolver for the 3-tier commission chain documented in CLAUDE.md.
//
// Order of precedence (the first hit wins, including rate=0 which is a valid
// "free for this user/merchant" override):
//   1. UserCommissionSetting     — per-user override
//   2. MerchantCommissionSetting — per-merchant override (looked up via the
//      user's merchantId)
//   3. CommissionSetting         — global default
//
// Why this file exists:
//   The resolver was previously duplicated inline in five places and every
//   copy only chained User → Global. MerchantCommissionSetting rows were
//   written through the admin UI but never read at fee-calculation time, so a
//   merchant-tier override was silently inert (off-by-one tier of fees =
//   silent revenue/contract violation). This module is the single read path
//   every fee site must go through.

const User = require('../models/User');
const UserCommissionSetting = require('../models/UserCommissionSetting');
const MerchantCommissionSetting = require('../models/MerchantCommissionSetting');
const CommissionSetting = require('../models/CommissionSetting');

// Resolve the commission setting for (userId, type). Looks up the user's
// merchantId from the User row (single DB read; cheap and avoids requiring
// callers to pre-load it). Returns the raw setting document plus a
// `sourceLayer` field indicating which tier won — usable for audit-trail
// writes on the CommissionLedger row.
async function resolveCommission(userId, type) {
  if (!userId || !type) return null;

  // Tier 1 — user-level override.
  const userLevel = await UserCommissionSetting.findOne({ userId, type });
  if (userLevel) {
    return Object.assign(userLevel.toObject ? userLevel.toObject() : userLevel, { sourceLayer: 'user' });
  }

  // Tier 2 — merchant-level override (only meaningful when the user belongs
  // to a merchant).
  const user = await User.findById(userId).select('merchantId');
  if (user?.merchantId) {
    const merchantLevel = await MerchantCommissionSetting.findOne({ merchantId: user.merchantId, type });
    if (merchantLevel) {
      return Object.assign(merchantLevel.toObject ? merchantLevel.toObject() : merchantLevel, { sourceLayer: 'merchant' });
    }
  }

  // Tier 3 — global default.
  const globalLevel = await CommissionSetting.findOne({ type });
  if (globalLevel) {
    return Object.assign(globalLevel.toObject ? globalLevel.toObject() : globalLevel, { sourceLayer: 'global' });
  }

  return null;
}

module.exports = { resolveCommission };
