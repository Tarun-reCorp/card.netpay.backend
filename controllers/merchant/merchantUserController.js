const User = require('../../models/User');

// GET /merchant/users
exports.listUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, kycStatus, search } = req.query;
    const filter = { merchantId: req.merchant._id };
    if (kycStatus) filter.kycStatus = kycStatus;
    if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];

    const users = await User.find(filter).select('-password -twoFactorSecret')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await User.countDocuments(filter);
    res.json({ success: true, users, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
