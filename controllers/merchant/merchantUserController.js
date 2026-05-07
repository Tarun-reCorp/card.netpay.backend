const User = require('../../models/User');
const Card = require('../../models/Card');

// GET /merchant/users
exports.listUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, kycStatus, search } = req.query;
    const filter = { merchantId: req.merchant._id };
    if (kycStatus) filter.kycStatus = kycStatus;
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }, { phone: re }];
    }

    const [users, total] = await Promise.all([
      User.find(filter).select('-password -twoFactorSecret')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      User.countDocuments(filter),
    ]);

    const userIds = users.map(u => u._id);
    const cardCounts = await Card.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);
    const cardCountMap = {};
    cardCounts.forEach(cc => { cardCountMap[cc._id.toString()] = cc.count; });

    const enriched = users.map(u => ({
      ...u.toObject(),
      cardsCount: cardCountMap[u._id.toString()] || 0,
    }));

    res.json({ success: true, users: enriched, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
