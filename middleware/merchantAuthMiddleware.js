const jwt = require('jsonwebtoken');
const Merchant = require('../models/Merchant');

const merchantAuthMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_MERCHANT_SECRET);
    const merchant = await Merchant.findById(decoded.id).select('-password');
    if (!merchant) return res.status(401).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'active') return res.status(403).json({ success: false, message: 'Merchant account inactive' });
    req.merchant = merchant;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

module.exports = merchantAuthMiddleware;
