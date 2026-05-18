const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const AdminUser = require('../../models/AdminUser');

const SETUP_TOKEN_TTL   = '15m';
const MFA_CHALLENGE_TTL = '5m';

function issueSetupToken(adminId) {
  return jwt.sign(
    { id: adminId, purpose: '2fa_setup' },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: SETUP_TOKEN_TTL }
  );
}

function issueAuthToken(adminId) {
  return jwt.sign(
    { id: adminId },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

function issueMfaChallengeToken(adminId) {
  return jwt.sign(
    { id: adminId, purpose: '2fa_challenge' },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: MFA_CHALLENGE_TTL }
  );
}

function verifySetupToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_setup') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

function verifyMfaChallengeToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== '2fa_challenge') return null;
    return decoded.id;
  } catch {
    return null;
  }
}

function adminSummary(a) {
  return { id: a._id, name: a.name, email: a.email };
}

// POST /admin/auth/login
exports.login = async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    const password = typeof req.body?.password === 'string' ? req.body.password : null;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const admin = await AdminUser.findOne({ email });
    if (!admin || !admin.isActive) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (admin.twoFactorEnabled && admin.twoFactorSecret) {
      return res.json({
        success: true,
        requires2FA: true,
        mfaChallengeToken: issueMfaChallengeToken(admin._id),
      });
    }

    if (admin.twoFactorRequired) {
      return res.json({
        success: true,
        requires2FASetup: true,
        adminId: admin._id,
        setupToken: issueSetupToken(admin._id),
      });
    }

    res.json({ success: true, token: issueAuthToken(admin._id), admin: adminSummary(admin) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/auth/2fa/verify   body: { mfaChallengeToken, code }
exports.verify2FA = async (req, res) => {
  try {
    const { mfaChallengeToken, code } = req.body;
    if (!mfaChallengeToken) {
      return res.status(400).json({ success: false, message: 'mfaChallengeToken is required' });
    }
    const adminId = verifyMfaChallengeToken(mfaChallengeToken);
    if (!adminId) return res.status(401).json({ success: false, message: 'Invalid or expired challenge token' });

    const admin = await AdminUser.findById(adminId);
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (!admin.twoFactorEnabled || !admin.twoFactorSecret) {
      return res.status(400).json({ success: false, message: '2FA is not enabled for this admin' });
    }

    const valid = speakeasy.totp.verify({
      secret: admin.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

    res.json({ success: true, token: issueAuthToken(admin._id), admin: adminSummary(admin) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/auth/2fa/setup   body: { setupToken }  — used during forced setup at login
exports.setup2FA = async (req, res) => {
  try {
    const { setupToken } = req.body;
    const adminId = verifySetupToken(setupToken);
    if (!adminId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const admin = await AdminUser.findById(adminId);
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

    const issuer = process.env.APP_NAME || 'NetPay';
    const secret = speakeasy.generateSecret({ name: `${issuer} Admin (${admin.email})` });

    // Atomic precondition: refuse to overwrite an already-enabled 2FA secret.
    // Protects against a leaked/phished setupToken being replayed to rebind
    // an enrolled admin account to an attacker's authenticator.
    const claimed = await AdminUser.findOneAndUpdate(
      { _id: admin._id, twoFactorEnabled: { $ne: true } },
      { $set: { twoFactorSecret: secret.base32, twoFactorEnabled: false } },
      { new: true },
    );
    if (!claimed) {
      return res.status(409).json({ success: false, message: '2FA is already enabled for this admin.' });
    }

    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, qrCode: qr, secret: secret.base32 });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/auth/2fa/enable   body: { setupToken, code }
exports.enable2FA = async (req, res) => {
  try {
    const { setupToken, code } = req.body;
    const adminId = verifySetupToken(setupToken);
    if (!adminId) return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });

    const admin = await AdminUser.findById(adminId);
    if (!admin || !admin.twoFactorSecret) {
      return res.status(400).json({ success: false, message: 'Run setup first' });
    }

    const valid = speakeasy.totp.verify({
      secret: admin.twoFactorSecret, encoding: 'base32', token: String(code || ''), window: 1,
    });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid code' });

    await AdminUser.findByIdAndUpdate(admin._id, { twoFactorEnabled: true });

    res.json({ success: true, token: issueAuthToken(admin._id), admin: adminSummary(admin) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
