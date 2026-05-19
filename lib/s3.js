// Shared S3 client + presigned-URL helper.
//
// Files uploaded via multer-s3 (KYC documents, merchant logos/card images) are
// stored as opaque object keys on the merchant/user record. When the frontend
// needs to display them, we sign a short-lived GET URL via presign(key).
//
// One client instance is exported so connection pooling is shared across
// controllers. Reads AWS_REGION / AWS_BUCKET / AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY from env (see .env.example).

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Generate a 1-hour presigned GET URL for an S3 object key. Returns null for
// missing keys, the original string if it's already a full URL (legacy data
// from before the S3 migration), and null on signing errors so a broken key
// never breaks the response payload.
async function presign(key, expiresIn = 3600) {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  try {
    const cmd = new GetObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key });
    return await getSignedUrl(s3, cmd, { expiresIn });
  } catch {
    return null;
  }
}

module.exports = { s3, presign };
