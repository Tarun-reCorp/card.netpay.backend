const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');

// POST /auth/register
exports.register = async (req, res) => {
  try {
    const { name, email, password, firstName, lastName, birthday, country, phone, areaCode, mobile, town, address, postCode, merchantId } = req.body;

    const exists = await User.findOne({ email });
    if (exists) return res.status(422).json({ success: false, message: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hashed, firstName, lastName, birthday, country, phone, areaCode, mobile, town, address, postCode, merchantId: merchantId || null });

    await Wallet.create({ userId: user._id });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.isBlocked) return res.status(403).json({ success: false, message: 'Account blocked' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (user.twoFactorEnabled) {
      return res.json({ success: true, requires2FA: true, userId: user._id });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, kycStatus: user.kycStatus } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /auth/2fa/verify
exports.verify2FA = async (req, res) => {
  try {
    const { userId, code } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const valid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /auth/2fa/setup  (requires auth)
exports.setup2FA = async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `${process.env.APP_NAME} (${req.user.email})` });
    await User.findByIdAndUpdate(req.user._id, { twoFactorSecret: secret.base32 });

    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ success: true, qrCode: qr, secret: secret.base32 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /auth/2fa/enable  (requires auth)
exports.enable2FA = async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.user._id);

    const valid = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid code' });

    await User.findByIdAndUpdate(user._id, { twoFactorEnabled: true });
    res.json({ success: true, message: '2FA enabled' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /auth/forgot-password
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.twoFactorEnabled) {
      return res.json({ success: true, requires2FA: true, userId: user._id });
    }
    // Without 2FA - return a reset token directly (implement email flow if needed)
    const resetToken = jwt.sign({ id: user._id, purpose: 'reset' }, process.env.JWT_SECRET, { expiresIn: '15m' });
    res.json({ success: true, resetToken });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /auth/reset-password
exports.resetPassword = async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (decoded.purpose !== 'reset') return res.status(400).json({ success: false, message: 'Invalid token' });

    const hashed = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(decoded.id, { password: hashed });
    res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Invalid or expired token' });
  }
};
