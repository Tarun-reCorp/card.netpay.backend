const bcrypt = require('bcryptjs');
const Merchant = require('../../models/Merchant');
const MerchantCommissionSetting = require('../../models/MerchantCommissionSetting');
const User = require('../../models/User');

// GET /admin/merchants
exports.listMerchants = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const merchants = await Merchant.find(filter).select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Merchant.countDocuments(filter);
    res.json({ success: true, merchants, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/merchants/:id
exports.getMerchant = async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id).select('-password');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    const userCount = await User.countDocuments({ merchantId: merchant._id });
    res.json({ success: true, merchant, userCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/merchants
exports.createMerchant = async (req, res) => {
  try {
    const { name, tag, email, password, phone, status, type, titleTag, showPoweredBy, primaryColor, secondaryColor, virtualMinDeposit, physicalMinDeposit } = req.body;
    const hashed = await bcrypt.hash(password, 12);
    const merchant = await Merchant.create({ name, tag, email, password: hashed, phone, status: status || 'active', type, titleTag, showPoweredBy, primaryColor, secondaryColor, virtualMinDeposit, physicalMinDeposit });
    res.status(201).json({ success: true, merchant: { id: merchant._id, name: merchant.name, email: merchant.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id
exports.updateMerchant = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates.password;
    const merchant = await Merchant.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password');
    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id/activate
exports.activateMerchant = async (req, res) => {
  try {
    await Merchant.findByIdAndUpdate(req.params.id, { status: 'active' });
    res.json({ success: true, message: 'Merchant activated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id/deactivate
exports.deactivateMerchant = async (req, res) => {
  try {
    await Merchant.findByIdAndUpdate(req.params.id, { status: 'inactive' });
    res.json({ success: true, message: 'Merchant deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/merchants/:id/commission
exports.getMerchantCommission = async (req, res) => {
  try {
    const settings = await MerchantCommissionSetting.find({ merchantId: req.params.id });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id/commission
exports.updateMerchantCommission = async (req, res) => {
  try {
    const { type, rateType, rate } = req.body;
    await MerchantCommissionSetting.findOneAndUpdate(
      { merchantId: req.params.id, type },
      { rateType, rate },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Merchant commission updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
