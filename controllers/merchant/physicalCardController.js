const PhysicalCardNumber = require('../../models/PhysicalCardNumber');
const User = require('../../models/User');

// GET /merchant/physical-cards/stats
exports.physicalCardStats = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const [total, available, preassigned, used] = await Promise.all([
      PhysicalCardNumber.countDocuments({ merchantId }),
      PhysicalCardNumber.countDocuments({ merchantId, isUsed: false, preAssignedUserId: null }),
      PhysicalCardNumber.countDocuments({ merchantId, isUsed: false, preAssignedUserId: { $ne: null } }),
      PhysicalCardNumber.countDocuments({ merchantId, isUsed: true }),
    ]);
    res.json({ success: true, stats: { total, available, preassigned, used } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /merchant/physical-cards
exports.listPhysicalCards = async (req, res) => {
  try {
    const { page = 1, limit = 40, statusFilter } = req.query;
    const merchantId = req.merchant._id;
    const filter = { merchantId };

    if (statusFilter === 'available')    { filter.isUsed = false; filter.preAssignedUserId = null; }
    else if (statusFilter === 'preassigned') { filter.isUsed = false; filter.preAssignedUserId = { $ne: null }; }
    else if (statusFilter === 'used')    { filter.isUsed = true; }

    const [cards, total] = await Promise.all([
      PhysicalCardNumber.find(filter)
        .populate('preAssignedUserId', 'name email')
        .populate({
          path: 'cardId',
          select: 'status cardNo userId',
          populate: { path: 'userId', select: 'name email' },
        })
        .sort({ isUsed: 1, createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      PhysicalCardNumber.countDocuments(filter),
    ]);
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

    // Unassign any existing pre-assigned card for this user (match PHP logic)
    await PhysicalCardNumber.updateMany(
      { preAssignedUserId: userId, isUsed: false },
      { $set: { preAssignedUserId: null, preAssignedAt: null } }
    );

    card.preAssignedUserId = userId;
    card.preAssignedAt = new Date();
    await card.save();
    res.json({ success: true, message: `Card pre-assigned to ${user.name}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /merchant/physical-cards/:id/unassign
exports.unassignFromUser = async (req, res) => {
  try {
    const card = await PhysicalCardNumber.findOne({ _id: req.params.id, merchantId: req.merchant._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.isUsed) return res.status(400).json({ success: false, message: 'Card already used' });

    card.preAssignedUserId = null;
    card.preAssignedAt = null;
    await card.save();
    res.json({ success: true, message: 'Pre-assignment removed. Card returned to merchant pool.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
