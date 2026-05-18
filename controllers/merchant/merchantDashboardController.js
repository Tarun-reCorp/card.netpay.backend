const User = require('../../models/User');
const Card = require('../../models/Card');
const PhysicalCardNumber = require('../../models/PhysicalCardNumber');

// GET /merchant/dashboard
exports.dashboard = async (req, res) => {
  try {
    const userIds = await User.distinct('_id', { merchantId: req.merchant._id });
    const [totalUsers, totalCards, availablePhysicalCards] = await Promise.all([
      User.countDocuments({ merchantId: req.merchant._id }),
      Card.countDocuments({ userId: { $in: userIds } }),
      PhysicalCardNumber.countDocuments({ merchantId: req.merchant._id, isUsed: false }),
    ]);
    res.json({ success: true, stats: { totalUsers, totalCards, availablePhysicalCards } });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /merchant/profile
exports.profile = async (req, res) => {
  try {
    const m = req.merchant;
    res.json({
      success: true,
      merchant: {
        id: m._id, name: m.name, email: m.email,
        phone: m.phone, status: m.status, tag: m.tag,
        createdAt: m.createdAt,
      },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
