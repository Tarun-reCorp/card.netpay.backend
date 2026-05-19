const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const multerS3 = require('multer-s3');
const Merchant = require('../../models/Merchant');
const MerchantCommissionSetting = require('../../models/MerchantCommissionSetting');
const CommissionSetting = require('../../models/CommissionSetting');
const User = require('../../models/User');
const { writeAudit } = require('../../lib/audit');
const { s3 } = require('../../lib/s3');
const { withSignedBrandUrls, merchantBrandSummary } = require('../../lib/merchantBrand');

// ── multer for merchant branding uploads ─────────────────────────────────────
// Files are stored under `merchant/{merchantId|tmp}/{logo|card}-{ts}-{name}`
// and served back as 1h presigned GET URLs via lib/s3.js.

const merchantS3Storage = multerS3({
  s3,
  bucket: process.env.AWS_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    // On create we don't have an id yet — use 'tmp' which the controller is
    // free to leave in place (object key never changes after upload).
    const id = req.params?.id || 'tmp';
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `merchant/${id}/${file.fieldname}-${Date.now()}-${safe}`);
  },
});

const merchantUpload = multer({
  storage: merchantS3Storage,
  // Logo is small (max 2 MB in the Laravel original), card_image can be larger
  // (max 4 MB). We use a single 5 MB ceiling here — frontend should enforce
  // the per-field limits for UX.
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

// Route-level middleware — accepts optional `logo` + `cardImage` file fields.
exports.uploadMerchantImages = merchantUpload.fields([
  { name: 'logo',      maxCount: 1 },
  { name: 'cardImage', maxCount: 1 },
]);

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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
      Merchant.find(filter).select('-password -twoFactorSecret').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
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

    const enriched = await Promise.all(merchants.map(async m => {
      const obj = {
        ...m.toObject(),
        userCount: countMap[m._id.toString()] || 0,
        ...merchantUrls(m),
      };
      await withSignedBrandUrls(obj);
      return obj;
    }));

    res.json({ success: true, merchants: enriched, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/merchants/:id
exports.getMerchant = async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id).select('-password -twoFactorSecret');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    const userCount = await User.countDocuments({ merchantId: merchant._id });
    const obj = { ...merchant.toObject(), ...merchantUrls(merchant) };
    await withSignedBrandUrls(obj);
    res.json({ success: true, merchant: obj, userCount });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/merchants
//
// Accepts multipart/form-data when logo or cardImage files are present, plain
// JSON otherwise. The uploadMerchantImages middleware (applied at route level)
// parses the body in both cases.
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

    // Checkbox values arrive as strings ('true'/'false') over multipart.
    const showPoweredByBool = typeof showPoweredBy === 'string'
      ? showPoweredBy === 'true'
      : showPoweredBy !== false;

    const files = req.files || {};
    const logoKey      = files.logo?.[0]?.key      || null;
    const cardImageKey = files.cardImage?.[0]?.key || null;

    const merchant = await Merchant.create({
      name,
      tag: tag ? tag.toLowerCase() : undefined,
      email,
      password: hashed,
      phone: phone || null,
      status: 'active',
      type: merchantType,
      titleTag: titleTag || null,
      showPoweredBy: merchantType === 'whitelabel' ? false : showPoweredByBool,
      primaryColor:  primaryColor  || '#00c853',
      secondaryColor: secondaryColor || '#39ff14',
      logo:      logoKey,
      cardImage: cardImageKey,
      virtualMinDeposit:  virtualMinDeposit  ? Number(virtualMinDeposit)  : null,
      physicalMinDeposit: physicalMinDeposit ? Number(physicalMinDeposit) : null,
    });

    res.status(201).json({ success: true, merchant: { id: merchant._id, name: merchant.name, email: merchant.email } });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/merchants/:id
//
// Strict allow-list — only these fields can be mutated through the admin
// edit form. Mass-assignment via req.body (e.g. setting
// {twoFactorEnabled:false, twoFactorSecret:null, status:'active', isAdmin:true})
// to neutralize a merchant's 2FA or escalate privileges is no longer possible.
const MERCHANT_EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'tag', 'logo', 'cardImage', 'titleTag',
  'type', 'showPoweredBy', 'primaryColor', 'secondaryColor',
  'virtualMinDeposit', 'physicalMinDeposit',
  'address', 'country',
];

exports.updateMerchant = async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};
    for (const field of MERCHANT_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        updates[field] = body[field];
      }
    }

    // File uploads (logo / cardImage) override any string value sent in the
    // body — they always win since multer ran after parsing the multipart body.
    const files = req.files || {};
    if (files.logo?.[0])      updates.logo      = files.logo[0].key;
    if (files.cardImage?.[0]) updates.cardImage = files.cardImage[0].key;

    // multipart sends scalar booleans as strings.
    if (typeof updates.showPoweredBy === 'string') {
      updates.showPoweredBy = updates.showPoweredBy === 'true';
    }

    // Password is handled separately so the plaintext is hashed before write.
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return res.status(422).json({ success: false, message: 'Password must be at least 8 characters' });
      }
      updates.password = await bcrypt.hash(body.password, 12);
    }

    if (updates.type === 'whitelabel') updates.showPoweredBy = false;
    if (updates.tag && typeof updates.tag === 'string') updates.tag = updates.tag.toLowerCase();
    if (updates.email && typeof updates.email === 'string') updates.email = updates.email.trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(updates, 'virtualMinDeposit')) {
      const v = updates.virtualMinDeposit;
      updates.virtualMinDeposit = (v === '' || v === null || v === undefined) ? null : Number(v);
      if (updates.virtualMinDeposit !== null && (!Number.isFinite(updates.virtualMinDeposit) || updates.virtualMinDeposit < 0)) {
        return res.status(422).json({ success: false, message: 'virtualMinDeposit must be a non-negative finite number' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'physicalMinDeposit')) {
      const v = updates.physicalMinDeposit;
      updates.physicalMinDeposit = (v === '' || v === null || v === undefined) ? null : Number(v);
      if (updates.physicalMinDeposit !== null && (!Number.isFinite(updates.physicalMinDeposit) || updates.physicalMinDeposit < 0)) {
        return res.status(422).json({ success: false, message: 'physicalMinDeposit must be a non-negative finite number' });
      }
    }

    const merchant = await Merchant.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true, context: 'query' },
    ).select('-password -twoFactorSecret');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    res.json({ success: true, merchant });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/merchants/:id/2fa   body: { enabled: boolean }
// Enabling: flag the merchant so the next login forces them through TOTP setup.
// Disabling: clear the requirement, the activation flag, and the stored secret.
exports.toggleMerchant2FA = async (req, res) => {
  try {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    const updates = enabled
      ? { twoFactorRequired: true }
      : { twoFactorRequired: false, twoFactorEnabled: false, twoFactorSecret: null };

    const merchant = await Merchant.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select('-password -twoFactorSecret');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    writeAudit(req, {
      action: enabled ? 'merchant.2fa.require' : 'merchant.2fa.disable',
      targetType: 'Merchant',
      targetId: merchant._id,
      payload: { merchantEmail: merchant.email },
    });

    res.json({
      success: true,
      message: enabled ? '2FA required on next login' : '2FA disabled and reset',
      merchant,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/merchants/:id/activate
exports.activateMerchant = async (req, res) => {
  try {
    await Merchant.findByIdAndUpdate(req.params.id, { status: 'active' });
    res.json({ success: true, message: 'Merchant activated' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/merchants/:id/deactivate
exports.deactivateMerchant = async (req, res) => {
  try {
    await Merchant.findByIdAndUpdate(req.params.id, { status: 'inactive' });
    res.json({ success: true, message: 'Merchant deactivated' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/merchants/:id/login-as
exports.loginAsMerchant = async (req, res) => {
  try {
    const merchant = await Merchant.findById(req.params.id).select('-password -twoFactorSecret');
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'active') return res.status(403).json({ success: false, message: 'Merchant is inactive' });
    const token = jwt.sign(
      { id: merchant._id, actorAdminId: String(req.admin?._id || ''), purpose: 'impersonation' },
      process.env.JWT_MERCHANT_SECRET,
      { expiresIn: '1h' },
    );
    writeAudit(req, {
      action: 'session.impersonateMerchant',
      targetType: 'Merchant',
      targetId: merchant._id,
      payload: { merchantEmail: merchant.email },
    });
    // Return the full brand summary so the impersonating admin's new tab can
    // theme MerchantLayout immediately, without a second /merchant/profile
    // round-trip (which wouldn't run until after the redirect anyway).
    res.json({ success: true, token, merchant: await merchantBrandSummary(merchant) });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/merchants/:id/commission
exports.updateMerchantCommission = async (req, res) => {
  try {
    const { commission, virtualMinDeposit, physicalMinDeposit } = req.body;

    if (commission && typeof commission === 'object') {
      for (const [type, s] of Object.entries(commission)) {
        if (!s || typeof s !== 'object') {
          return res.status(422).json({ success: false, message: `Invalid commission payload for ${type}` });
        }
        const rateType = s.rateType === 'fixed' ? 'fixed' : 'percentage';
        const rate = Number(s.rate);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(422).json({ success: false, message: `rate must be a non-negative finite number (${type})` });
        }
        const cap = rateType === 'percentage' ? 100 : 10000;
        if (rate > cap) {
          return res.status(422).json({ success: false, message: `rate exceeds maximum (${cap}) for ${rateType} commission on ${type}` });
        }
        await MerchantCommissionSetting.findOneAndUpdate(
          { merchantId: req.params.id, type },
          { rateType, rate },
          { upsert: true, new: true, runValidators: true },
        );
      }
    }

    const minUpdate = {};
    if (virtualMinDeposit  !== undefined) {
      const v = virtualMinDeposit ? Number(virtualMinDeposit) : null;
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        return res.status(422).json({ success: false, message: 'virtualMinDeposit must be a non-negative finite number' });
      }
      minUpdate.virtualMinDeposit = v;
    }
    if (physicalMinDeposit !== undefined) {
      const v = physicalMinDeposit ? Number(physicalMinDeposit) : null;
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        return res.status(422).json({ success: false, message: 'physicalMinDeposit must be a non-negative finite number' });
      }
      minUpdate.physicalMinDeposit = v;
    }
    if (Object.keys(minUpdate).length) await Merchant.findByIdAndUpdate(req.params.id, minUpdate);

    res.json({ success: true, message: 'Commission settings updated' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
