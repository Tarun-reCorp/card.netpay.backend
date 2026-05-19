// Helpers for projecting merchant brand data into API responses.
//
// `logo` and `cardImage` are stored on the merchant document as opaque S3
// keys. Anywhere the frontend needs to render them (admin merchant list,
// merchant-side login response, merchant /profile, admin impersonation) we
// have to sign GET URLs first. These helpers are the single place that
// happens — pass in a merchant document or plain object, get back something
// safe to ship to the client.

const { presign } = require('./s3');

// Mutate-and-return: attach `logoUrl` + `cardImageUrl` (1h presigned) to a
// merchant POJO. Use this when the rest of the merchant record is already
// being serialized (admin list/detail).
async function withSignedBrandUrls(obj) {
  if (!obj) return obj;
  const [logo, cardImage] = await Promise.all([presign(obj.logo), presign(obj.cardImage)]);
  obj.logoUrl      = logo;
  obj.cardImageUrl = cardImage;
  return obj;
}

// Build the merchant summary used by auth + profile endpoints. The fields
// here drive both auth (id, name, email, status) and the merchant-portal
// theming (primaryColor, secondaryColor, titleTag, type, showPoweredBy,
// logoUrl, cardImageUrl). Keep this in sync with what MerchantLayout reads
// from getProfile('merchant') on the frontend.
async function merchantBrandSummary(m) {
  if (!m) return null;
  const [logoUrl, cardImageUrl] = await Promise.all([presign(m.logo), presign(m.cardImage)]);
  return {
    id:              m._id,
    name:            m.name,
    email:           m.email,
    phone:           m.phone,
    status:          m.status,
    tag:             m.tag,
    type:            m.type,
    titleTag:        m.titleTag,
    showPoweredBy:   m.showPoweredBy,
    primaryColor:    m.primaryColor,
    secondaryColor:  m.secondaryColor,
    logoUrl,
    cardImageUrl,
  };
}

module.exports = { withSignedBrandUrls, merchantBrandSummary };
