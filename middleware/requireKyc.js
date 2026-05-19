const { KYC_STATUS } = require('../config/statuses');

// Gate that blocks every balance-moving / account-mutating action unless the
// caller's KYC is approved. Must be mounted after `authMiddleware` so
// `req.user` is populated.
//
// We respond with 403 + a status-aware message so the frontend can show the
// user exactly which step is missing instead of a generic "forbidden".
const requireKyc = (req, res, next) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  if (user.kycStatus === KYC_STATUS.APPROVED) return next();

  const messages = {
    [KYC_STATUS.NOT_SUBMITTED]: 'KYC verification required. Please submit your KYC documents to continue.',
    [KYC_STATUS.PENDING]:       'Your KYC submission is awaiting review. This action will unlock once it is approved.',
    [KYC_STATUS.IN_REVIEW]:     'Your KYC is currently being reviewed. This action will unlock once it is approved.',
    [KYC_STATUS.REJECTED]:      'Your KYC was rejected. Please re-submit your documents to continue.',
  };

  return res.status(403).json({
    success: false,
    code: 'kyc_required',
    kycStatus: user.kycStatus || KYC_STATUS.NOT_SUBMITTED,
    message: messages[user.kycStatus] || 'KYC approval is required to perform this action.',
  });
};

module.exports = requireKyc;
