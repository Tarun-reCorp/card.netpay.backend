const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const Merchant = require('../../models/Merchant');
const { merchantBrandSummary } = require('../../lib/merchantBrand');

const SETUP_TOKEN_TTL   = '15m';
const MFA_CHALLENGE_TTL = '5m';

function issueSetupToken(merchantId) {
  return jwt.sign(
    { id: merchantId, purpose: '2fa_setup' },
    process.env.JWT_MERCHANT_SECRET,
    { expiresIn: SETUP_TOKEN_TTL }
  );
}

function issueAuthToken(merchantId) {
  return jwt.sign(
    { id: merchantId },
    process.env.JWT_MERCHANT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

function issueMfaChallengeToken(merchantId) {
  return jwt.sign(
    { id: merchantId, purpose: '2fa_challenge' },
    process.env.JWT_MERCHANT_SECRET,
    { expiresIn: MFA_CHALLENGE_TTL }
  );
}

function verifySetupToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_MERCHANT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_setup') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

function verifyMfaChallengeToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_MERCHANT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_challenge') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

// Auth-response summary. Includes brand fields (primary/secondary colors,
// presigned logo+cardImage URLs, titleTag, type, showPoweredBy) so that
// MerchantLayout on the frontend can theme the portal as soon as the session
// is stored — no extra round-trip needed.
async function merchantSummary(m) {
  return merchantBrandSummary(m);
}

// POST /merchant/auth/login
exports.login = async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    const password = typeof req.body?.password === 'string' ? req.body.password : null;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const merchant = await Merchant.findOne({ email });
    if (!merchant) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (merchant.status !== 'active') return res.status(403).json({ success: false, message: 'Account inactive' });

    const match = await bcrypt.compare(password, merchant.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // 2FA already configured — require TOTP code before issuing the auth token.
    if (merchant.twoFactorEnabled && merchant.twoFactorSecret) {
      return res.json({
        success: true,
        requires2FA: true,
        mfaChallengeToken: issueMfaChallengeToken(merchant._id),
      });
    }

    // Admin has flagged this merchant as required to set up 2FA — force setup before login completes.
    if (merchant.twoFactorRequired) {
      return res.json({
        success: true,
        requires2FASetup: true,
        merchantId: merchant._id,
        setupToken: issueSetupToken(merchant._id),
      });
    }

    res.json({ success: true, token: issueAuthToken(merchant._id), merchant: await merchantSummary(merchant) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /merchant/auth/2fa/verify   body: { mfaChallengeToken, code }
exports.verify2FA = async (req, res) => {
  try {
    const { mfaChallengeToken, code } = req.body;
    if (!mfaChallengeToken) {
      return res.status(400).json({ success: false, message: 'mfaChallengeToken is required' });
    }
    const merchantId = verifyMfaChallengeToken(mfaChallengeToken);
    if (!merchantId) return res.status(401).json({ success: false, message: 'Invalid or expired challenge token' });

    const merchant = await Merchant.findById(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (!merchant.twoFactorEnabled || !merchant.twoFactorSecret) {
      return res.status(400).json({ success: false, message: '2FA is not enabled for this merchant' });
    }

    const valid = speakeasy.totp.verify({
      secret: merchant.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

    res.json({ success: true, token: issueAuthToken(merchant._id), merchant: await merchantSummary(merchant) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /merchant/auth/2fa/setup   body: { setupToken }  — used during forced setup at login
// Returns the QR code + base32 secret. Secret is stored on the merchant record but
// twoFactorEnabled stays false until /enable verifies a code.
exports.setup2FA = async (req, res) => {
  try {
    const { setupToken } = req.body;
    const merchantId = verifySetupToken(setupToken);
    if (!merchantId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const merchant = await Merchant.findById(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const issuer = process.env.APP_NAME || 'NetPay';
    const secret = speakeasy.generateSecret({ name: `${issuer} Merchant (${merchant.email})` });

    // Atomic precondition: refuse to overwrite an already-enabled 2FA secret.
    // Protects against a leaked/phished setupToken being replayed to rebind
    // an enrolled merchant account to an attacker's authenticator.
    const claimed = await Merchant.findOneAndUpdate(
      { _id: merchant._id, twoFactorEnabled: { $ne: true } },
      { $set: { twoFactorSecret: secret.base32, twoFactorEnabled: false } },
      { new: true },
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: '2FA is already enabled for this merchant.' });
    }

    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, qrCode: qr, secret: secret.base32 });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /merchant/auth/2fa/enable   body: { setupToken, code }
exports.enable2FA = async (req, res) => {
  try {
    const { setupToken, code } = req.body;
    const merchantId = verifySetupToken(setupToken);
    if (!merchantId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const merchant = await Merchant.findById(merchantId);
    if (!merchant || !merchant.twoFactorSecret) {
      return res.status(400).json({ success: false, message: 'Run setup first' });
    }

    const valid = speakeasy.totp.verify({
      secret: merchant.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid code' });

    await Merchant.findByIdAndUpdate(merchant._id, { twoFactorEnabled: true });

    res.json({ success: true, token: issueAuthToken(merchant._id), merchant: await merchantSummary(merchant) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
