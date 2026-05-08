const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Merchant = require('../../models/Merchant');
const MerchantCommissionSetting = require('../../models/MerchantCommissionSetting');
const CommissionSetting = require('../../models/CommissionSetting');
const User = require('../../models/User');

function merchantUrls(merchant) {
  const base = (process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  return {
    // White-label user portal (handles login + register in one page via /:tag route)
    portalUrl: merchant.tag ? `${base}/${merchant.tag}` : null,
    // Merchant staff login (same URL for all merchants)
    loginUrl:  `${base}/merchant/login`,
  };
}

// GET /admin/merchants/stats
exports.merchantStats = async (req, res) => {
  try {
    const [total, active, inactive, whitelabel] = await Promise.all([
      Merchant.countDocuments(),
      Merchant.countDocuments({ status: 'active' }),
      Merchant.countDocuments({ status: 'inactive' }),
      Merchant.countDocuments({ type: 'whitelabel' }),
    ]);
    res.json({ success: true, total, active, inactive, whitelabel });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/merchants
exports.listMerchants = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type)   filter.type = type;
    if (search) filter.$or = [
      { name: new RegExp(search, 'i') },
      { email: new RegExp(search, 'i') },
      { phone: new RegExp(search, 'i') },
    ];

    const [merchants, total] = await Promise.all([
      Merchant.find(filter).select('-password').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Merchant.countDocuments(filter),
    ]);

    // Enrich with user counts
    const merchantIds = merchants.map(m => m._id);
    const userCounts = await User.aggregate([
      { $match: { merchantId: { $in: merchantIds } } },
      { $group: { _id: '$merchantId', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    userCounts.forEach(u => { countMap[u._id.toString()] = u.count; });

    const enriched = merchants.map(m => ({
      ...m.toObject(),
      userCount: countMap[m._id.toString()] || 0,
      ...merchantUrls(m),
    }));

    res.json({ success: true, merchants: enriched, total });
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
    res.json({ success: true, merchant: { ...merchant.toObject(), ...merchantUrls(merchant) }, userCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/merchants
exports.createMerchant = async (req, res) => {
  try {
    const { name, tag, email, password, phone, type, titleTag, showPoweredBy, primaryColor, secondaryColor, virtualMinDeposit, physicalMinDeposit } = req.body;

    if (!password || password.length < 8)
      return res.status(422).json({ success: false, message: 'Password must be at least 8 characters' });

    if (await Merchant.findOne({ email }))
      return res.status(422).json({ success: false, message: 'Email already registered' });

    if (tag && await Merchant.findOne({ tag: tag.toLowerCase() }))
      return res.status(422).json({ success: false, message: 'URL tag already taken' });

    const hashed = await bcrypt.hash(password, 12);
    const merchantType = type || 'netpay_owned';

    const merchant = await Merchant.create({
      name,
      tag: tag ? tag.toLowerCase() : undefined,
      email,
      password: hashed,
      phone: phone || null,
      status: 'active',
      type: merchantType,
      titleTag: titleTag || null,
      showPoweredBy: merchantType === 'whitelabel' ? false : (showPoweredBy !== false),
      primaryColor:  primaryColor  || '#00c853',
      secondaryColor: secondaryColor || '#39ff14',
      virtualMinDeposit:  virtualMinDeposit  ? Number(virtualMinDeposit)  : null,
      physicalMinDeposit: physicalMinDeposit ? Number(physicalMinDeposit) : null,
    });

    res.status(201).json({ success: true, merchant: { id: merchant._id, name: merchant.name, email: merchant.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id
exports.updateMerchant = async (req, res) => {
  try {
    const { password, ...updates } = req.body;

    if (password) {
      if (password.length < 8)
        return res.status(422).json({ success: false, message: 'Password must be at least 8 characters' });
      updates.password = await bcrypt.hash(password, 12);
    }

    if (updates.type === 'whitelabel') updates.showPoweredBy = false;
    if (updates.tag) updates.tag = updates.tag.toLowerCase();

    const merchant = await Merchant.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
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

// POST /admin/merchants/:id/login-as
exports.loginAsMerchant = async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id).select('-password');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'active') return res.status(403).json({ success: false, message: 'Merchant is inactive' });
    const token = jwt.sign({ id: merchant._id }, process.env.JWT_MERCHANT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, token, merchant: { id: merchant._id, name: merchant.name, email: merchant.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/merchants/:id/commission
exports.getMerchantCommission = async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id).select('virtualMinDeposit physicalMinDeposit');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const types = ['deposit', 'withdrawal', 'card_issuance_virtual', 'card_issuance_physical'];
    const [merchantSettings, globalSettings] = await Promise.all([
      MerchantCommissionSetting.find({ merchantId: req.params.id }),
      CommissionSetting.find({ type: { $in: types } }),
    ]);

    const merchantMap = {};
    merchantSettings.forEach(s => { merchantMap[s.type] = s; });
    const globalMap = {};
    globalSettings.forEach(s => { globalMap[s.type] = s; });

    const commission = {};
    types.forEach(type => {
      const custom = merchantMap[type];
      const global = globalMap[type];
      commission[type] = {
        rateType: custom ? custom.rateType : (global?.rateType || 'percentage'),
        rate:     custom ? custom.rate     : (global?.rate     ?? 0),
        custom:   !!custom,
      };
    });

    res.json({
      success: true,
      commission,
      virtualMinDeposit:  merchant.virtualMinDeposit,
      physicalMinDeposit: merchant.physicalMinDeposit,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/merchants/:id/commission
exports.updateMerchantCommission = async (req, res) => {
  try {
    const { commission, virtualMinDeposit, physicalMinDeposit } = req.body;

    if (commission) {
      for (const [type, s] of Object.entries(commission)) {
        await MerchantCommissionSetting.findOneAndUpdate(
          { merchantId: req.params.id, type },
          { rateType: s.rateType, rate: Number(s.rate) },
          { upsert: true, new: true },
        );
      }
    }

    const minUpdate = {};
    if (virtualMinDeposit  !== undefined) minUpdate.virtualMinDeposit  = virtualMinDeposit  ? Number(virtualMinDeposit)  : null;
    if (physicalMinDeposit !== undefined) minUpdate.physicalMinDeposit = physicalMinDeposit ? Number(physicalMinDeposit) : null;
    if (Object.keys(minUpdate).length) await Merchant.findByIdAndUpdate(req.params.id, minUpdate);

    res.json({ success: true, message: 'Commission settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
