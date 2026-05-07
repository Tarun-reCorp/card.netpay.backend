const PhysicalCardNumber = require('../../models/PhysicalCardNumber');
const User = require('../../models/User');

// GET /merchant/physical-cards
exports.listPhysicalCards = async (req, res) => {
  try {
    const { page = 1, limit = 20, isUsed } = req.query;
    const filter = { merchantId: req.merchant._id };
    if (isUsed !== undefined) filter.isUsed = isUsed === 'true';

    const cards = await PhysicalCardNumber.find(filter)
      .populate('preAssignedUserId', 'name email')
      .populate('cardId', 'status cardNo')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await PhysicalCardNumber.countDocuments(filter);
    res.json({ success: true, cards, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /merchant/physical-cards/:id/assign-user
exports.assignToUser = async (req, res) => {
  try {
    const { userId } = req.body;
    const card = await PhysicalCardNumber.findOne({ _id: req.params.id, merchantId: req.merchant._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.isUsed) return res.status(400).json({ success: false, message: 'Card already used' });

    const user = await User.findOne({ _id: userId, merchantId: req.merchant._id });
    if (!user) return res.status(404).json({ success: false, message: 'User not found under this merchant' });

    card.preAssignedUserId = userId;
    card.preAssignedAt = new Date();
    await card.save();
    res.json({ success: true, message: 'Card pre-assigned to user' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /merchant/physical-cards/:id/unassign
exports.unassignFromUser = async (req, res) => {
  try {
    const card = await PhysicalCardNumber.findOne({ _id: req.params.id, merchantId: req.merchant._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    card.preAssignedUserId = null;
    card.preAssignedAt = null;
    await card.save();
    res.json({ success: true, message: 'Pre-assignment removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
