const User = require('../../models/User');
const Card = require('../../models/Card');

// GET /merchant/cards
exports.listCards = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, cardType } = req.query;

    const merchantUserIds = await User.distinct('_id', { merchantId: req.merchant._id });

    const filter = { userId: { $in: merchantUserIds } };
    if (status) filter.status = status;
    if (cardType) filter.cardType = cardType;

    const cards = await Card.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Card.countDocuments(filter);

    res.json({ success: true, cards, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
