const multer   = require('multer');
const multerS3  = require('multer-s3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const User = require('../../models/User');

// ── S3 Client ─────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Multer S3 Upload ──────────────────────────────────────────────────────────

const s3Storage = multerS3({
  s3,
  bucket: process.env.AWS_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    const userId = req.user?._id || 'unknown';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `kyc/${userId}/${Date.now()}-${safeName}`);
  },
});

exports.upload = multer({
  storage: s3Storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// ── Helper: generate presigned URL (1-hour expiry) ────────────────────────────

async function presign(key) {
  if (!key) return null;
  // Already a full URL (old local path saved as URL) — return as-is
  if (key.startsWith('http')) return key;
  try {
    const cmd = new GetObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key });
    return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
  } catch {
    return null;
  }
}

// ── GET /user/kyc ─────────────────────────────────────────────────────────────

exports.getKyc = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('kycStatus kycDocType kycDocFront kycDocBack kycSelfie kycDob kycIdNumber kycIssueDate kycExpiryDate kycRejectReason kycSubmittedAt');

    const obj = user.toObject();

    // Generate presigned URLs for S3 keys
    const [front, back, selfie] = await Promise.all([
      presign(obj.kycDocFront),
      presign(obj.kycDocBack),
      presign(obj.kycSelfie),
    ]);

    obj.kycDocFront = front;
    obj.kycDocBack  = back;
    obj.kycSelfie   = selfie;

    res.json({ success: true, kyc: obj });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── POST /user/kyc/submit ─────────────────────────────────────────────────────

exports.submitKyc = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.kycStatus === 'approved') {
      return res.status(400).json({ success: false, message: 'KYC already approved' });
    }

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

    // multer-s3 stores the S3 object key in file.key
    if (files.kycDocFront?.[0]) update.kycDocFront = files.kycDocFront[0].key;
    if (files.kycDocBack?.[0])  update.kycDocBack  = files.kycDocBack[0].key;
    if (files.kycSelfie?.[0])   update.kycSelfie   = files.kycSelfie[0].key;

    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true, message: 'KYC submitted successfully' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
