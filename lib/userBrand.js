// Build the user-summary payload returned by /auth/login, /auth/register,
// /auth/2fa/verify, /auth/2fa/enable, and /user/profile.
//
// When the user belongs to a merchant, attach a `merchant` block with the
// brand fields so the frontend's user Layout can theme itself on the FIRST
// render after login — without a separate /user/profile round-trip (which
// would cause a ~200ms flicker of the default emerald theme).

const { presign } = require('./s3');

// Mongoose `.select(...)` string used wherever we want to load the user with
// their merchant brand. Keep this in sync with what `userBrandSummary` reads.
const MERCHANT_BRAND_SELECT = 'name tag titleTag type primaryColor secondaryColor logo cardImage showPoweredBy';

async function userBrandSummary(user) {
  if (!user) return null;
  const base = {
    id:        user._id,
    name:      user.name,
    email:     user.email,
    kycStatus: user.kycStatus,
  };
  const m = user.merchantId;
  if (m && typeof m === 'object' && m._id) {
    // Populated merchant document — include brand block with presigned URLs.
    const [logoUrl, cardImageUrl] = await Promise.all([
      presign(m.logo),
      presign(m.cardImage),
    ]);
    base.merchant = {
      id:             m._id,
      name:           m.name,
      tag:            m.tag,
      titleTag:       m.titleTag,
      type:           m.type,
      primaryColor:   m.primaryColor,
      secondaryColor: m.secondaryColor,
      showPoweredBy:  m.showPoweredBy,
      logoUrl,
      cardImageUrl,
    };
  } else {
    base.merchant = null;
  }
  return base;
}

module.exports = { userBrandSummary, MERCHANT_BRAND_SELECT };
