const User = require('../../models/User');
const Card = require('../../models/Card');

// GET /merchant/cards/stats
exports.cardStats = async (req, res) => {
  try {
    const userIds = await User.distinct('_id', { merchantId: req.merchant._id });
    const base = { userId: { $in: userIds } };
    const [total, active, frozen, cancelled, pending, virtual, physical] = await Promise.all([
      Card.countDocuments(base),
      Card.countDocuments({ ...base, status: 'active' }),
      Card.countDocuments({ ...base, status: { $in: ['frozen', 'freeze'] } }),
      Card.countDocuments({ ...base, status: 'cancelled' }),
      Card.countDocuments({ ...base, status: { $nin: ['active', 'frozen', 'freeze', 'cancelled'] } }),
      Card.countDocuments({ ...base, cardType: 'virtual' }),
      Card.countDocuments({ ...base, cardType: 'physical' }),
    ]);
    res.json({ success: true, stats: { total, active, frozen, cancelled, pending, virtual, physical } });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /merchant/cards
exports.listCards = async (req, res) => {
  try {
    const { page = 1, limit = 25, status, cardType, search } = req.query;
    const userIds = await User.distinct('_id', { merchantId: req.merchant._id });
    const filter = { userId: { $in: userIds } };
    if (status)   filter.status   = status === 'frozen' ? { $in: ['frozen', 'freeze'] } : status;
    if (cardType) filter.cardType = cardType;

    if (search) {
      const re = new RegExp(search, 'i');
      const matchUsers = await User.find({
        merchantId: req.merchant._id, $or: [{ name: re }, { email: re }],
      }).select('_id').lean();
      const matchIds = matchUsers.map(u => u._id);
      filter.$or = [
        { cardNo: re }, { holderEmail: re },
        ...(matchIds.length ? [{ userId: { $in: matchIds } }] : []),
      ];
    }

    const [cards, total] = await Promise.all([
      Card.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      Card.countDocuments(filter),
    ]);
    res.json({ success: true, cards, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
