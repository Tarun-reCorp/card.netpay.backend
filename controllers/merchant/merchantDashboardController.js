const User = require('../../models/User');
const Card = require('../../models/Card');
const PhysicalCardNumber = require('../../models/PhysicalCardNumber');

// GET /merchant/dashboard
exports.dashboard = async (req, res) => {
  try {
    const [totalUsers, totalCards, availablePhysicalCards] = await Promise.all([
      User.countDocuments({ merchantId: req.merchant._id }),
      Card.countDocuments({ userId: { $in: await User.distinct('_id', { merchantId: req.merchant._id }) } }),
      PhysicalCardNumber.countDocuments({ merchantId: req.merchant._id, isUsed: false }),
    ]);
    res.json({ success: true, stats: { totalUsers, totalCards, availablePhysicalCards } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
