const path = require('path');
const multer = require('multer');
const User = require('../../models/User');

const storage = multer.diskStorage({
  destination: 'uploads/kyc/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
exports.upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// GET /user/kyc
exports.getKyc = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('kycStatus kycDocType kycDocFront kycDocBack kycSelfie kycDob kycIdNumber kycIssueDate kycExpiryDate kycRejectReason kycSubmittedAt');
    const obj = user.toObject();
    // Normalize Windows backslashes to forward slashes for URLs
    ['kycDocFront', 'kycDocBack', 'kycSelfie'].forEach(k => {
      if (obj[k]) obj[k] = obj[k].replace(/\\/g, '/');
    });
    res.json({ success: true, kyc: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/kyc/submit
exports.submitKyc = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.kycStatus === 'approved') return res.status(400).json({ success: false, message: 'KYC already approved' });

    const { kycDocType, kycDob, kycIdNumber, kycIssueDate, kycExpiryDate } = req.body;
    const files = req.files || {};

    const update = {
      kycDocType,
      kycDob,
      kycIdNumber,
      kycIssueDate,
      kycExpiryDate,
      kycStatus: 'pending',
      kycSubmittedAt: new Date(),
    };

    if (files.kycDocFront) update.kycDocFront = files.kycDocFront[0].path;
    if (files.kycDocBack)  update.kycDocBack  = files.kycDocBack[0].path;
    if (files.kycSelfie)   update.kycSelfie   = files.kycSelfie[0].path;

    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true, message: 'KYC submitted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
