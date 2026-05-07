const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Merchant = require('../../models/Merchant');

// POST /merchant/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const merchant = await Merchant.findOne({ email });
    if (!merchant) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (merchant.status !== 'active') return res.status(403).json({ success: false, message: 'Account inactive' });

    const match = await bcrypt.compare(password, merchant.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = jwt.sign({ id: merchant._id }, process.env.JWT_MERCHANT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.json({ success: true, token, merchant: { id: merchant._id, name: merchant.name, email: merchant.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
