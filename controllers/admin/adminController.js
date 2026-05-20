const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const Card = require('../../models/Card');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
const AppSetting = require('../../models/AppSetting');
const HotWallet = require('../../models/HotWallet');
const PhysicalCardNumber = require('../../models/PhysicalCardNumber');
const WalletServiceLog = require('../../models/WalletServiceLog');
const UqpayApiLog = require('../../models/UqpayApiLog');
const Merchant = require('../../models/Merchant');
const AdminUser = require('../../models/AdminUser');
const { toMoney, MoneyError } = require('../../lib/money');
const { writeAudit } = require('../../lib/audit');
const {
  CARD_STATUS,
  DEPOSIT_STATUS,
  KYC_STATUS,
  TRANSACTION_STATUS,
} = require('../../config/statuses');

// ── S3 presigned URL helper ───────────────────────────────────────────────────
const s3Admin = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function presignKyc(key) {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  try {
    const cmd = new GetObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key });
    return await getSignedUrl(s3Admin, cmd, { expiresIn: 3600 });
  } catch { return null; }
}

// GET /admin/dashboard
exports.dashboard = async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      userAgg,
      merchantAgg,
      cardAgg,
      physPoolAgg,
      depositAgg,
      withdrawalAgg,
      commissionAgg,
      cardIssuanceFeesAgg,
      autoDeposits24h,
      recentUsers,
      recentTxns,
      recentCards,
      recentMerchants,
    ] = await Promise.all([
      User.aggregate([{
        $group: {
          _id: null,
          total:            { $sum: 1 },
          blocked:          { $sum: { $cond: ['$isBlocked', 1, 0] } },
          kycApproved:      { $sum: { $cond: [{ $eq: ['$kycStatus', 'approved'] }, 1, 0] } },
          kycPending:       { $sum: { $cond: [{ $in: ['$kycStatus', [KYC_STATUS.PENDING, KYC_STATUS.IN_REVIEW]] }, 1, 0] } },
          kycInReview:      { $sum: { $cond: [{ $eq: ['$kycStatus', 'in_review'] }, 1, 0] } },
          kycRejected:      { $sum: { $cond: [{ $eq: ['$kycStatus', 'rejected'] }, 1, 0] } },
          kycNotSubmitted:  { $sum: { $cond: [{ $eq: ['$kycStatus', 'not_submitted'] }, 1, 0] } },
          today:            { $sum: { $cond: [{ $gte: ['$createdAt', todayStart] }, 1, 0] } },
        },
      }]),
      Merchant.aggregate([{
        $group: {
          _id: null,
          total:      { $sum: 1 },
          active:     { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          inactive:   { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
          whitelabel: { $sum: { $cond: [{ $eq: ['$type', 'whitelabel'] }, 1, 0] } },
        },
      }]),
      Card.aggregate([{
        $group: {
          _id: null,
          total:         { $sum: 1 },
          active:        { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          frozen:        { $sum: { $cond: [{ $eq: ['$status', 'frozen'] }, 1, 0] } },
          cancelled:     { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          other:         { $sum: { $cond: [{ $in: ['$status', [CARD_STATUS.PENDING, CARD_STATUS.PROCESSING, CARD_STATUS.FAILED]] }, 1, 0] } },
          virtualCount:  { $sum: { $cond: [{ $eq: ['$cardType', 'virtual'] }, 1, 0] } },
          physicalCount: { $sum: { $cond: [{ $eq: ['$cardType', 'physical'] }, 1, 0] } },
          totalBalance:  { $sum: '$balance' },
        },
      }]),
      PhysicalCardNumber.aggregate([{
        $group: {
          _id: null,
          total:       { $sum: 1 },
          used:        { $sum: { $cond: ['$isUsed', 1, 0] } },
          available:   { $sum: { $cond: ['$isUsed', 0, 1] } },
          preAssigned: { $sum: { $cond: [{ $and: [{ $ne: ['$preAssignedUserId', null] }, { $eq: ['$isUsed', false] }] }, 1, 0] } },
        },
      }]),
      WalletTransaction.aggregate([
        { $match: { type: 'deposit' } },
        {
          $group: {
            _id: null,
            total:        { $sum: 1 },
            completed:    { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            pending:      { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            rejected:     { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
            totalAmount:  { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
            manualCount:  { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $regexMatch: { input: '$transactionId', regex: /^ADMIN-/i } }] }, 1, 0] } },
            manualAmount: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $regexMatch: { input: '$transactionId', regex: /^ADMIN-/i } }] }, '$amount', 0] } },
            autoCount:    { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $not: { $regexMatch: { input: '$transactionId', regex: /^ADMIN-/i } } }] }, 1, 0] } },
            autoAmount:   { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $not: { $regexMatch: { input: '$transactionId', regex: /^ADMIN-/i } } }] }, '$amount', 0] } },
            todayCount:   { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', todayStart] }] }, 1, 0] } },
            todayAmount:  { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', todayStart] }] }, '$amount', 0] } },
          },
        },
      ]),
      Withdrawal.aggregate([{
        $group: {
          _id: null,
          total:       { $sum: 1 },
          pending:     { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          completed:   { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          rejected:    { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
          totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
        },
      }]),
      CommissionLedger.aggregate([{
        $group: {
          _id: null,
          totalEarned:       { $sum: '$commissionAmount' },
          depositCommission: { $sum: { $cond: [{ $eq: ['$type', 'deposit'] }, '$commissionAmount', 0] } },
          cardCommission:    { $sum: { $cond: [{ $in: ['$type', ['card_issuance', 'card_issuance_virtual', 'card_issuance_physical']] }, '$commissionAmount', 0] } },
          count:             { $sum: 1 },
        },
      }]),
      WalletTransaction.aggregate([
        { $match: { type: { $in: ['card_issuance', 'card_issuance_virtual', 'card_issuance_physical'] }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Deposit.countDocuments({ createdAt: { $gte: dayAgo } }),
      User.find().sort({ createdAt: -1 }).limit(6).select('firstName lastName name email kycStatus isBlocked merchantId createdAt').populate('merchantId', 'name').lean(),
      WalletTransaction.find().sort({ createdAt: -1 }).limit(6).populate('userId', 'email firstName lastName name').lean(),
      Card.find().sort({ createdAt: -1 }).limit(5).populate('userId', 'firstName lastName name email').lean(),
      Merchant.find().sort({ createdAt: -1 }).limit(4).select('name email status type').lean(),
    ]);

    const u = userAgg[0] || {};
    const m = merchantAgg[0] || {};
    const c = cardAgg[0] || {};
    const p = physPoolAgg[0] || {};
    const d = depositAgg[0] || {};
    const w = withdrawalAgg[0] || {};
    const com = commissionAgg[0] || {};

    res.json({
      success: true,
      stats: {
        totalUsers:         u.total       || 0,
        totalCards:         c.total       || 0,
        totalMerchants:     m.total       || 0,
        pendingDeposits:    d.pending     || 0,
        pendingWithdrawals: w.pending     || 0,
      },
      userStats: {
        total:           u.total           || 0,
        blocked:         u.blocked         || 0,
        kycApproved:     u.kycApproved     || 0,
        kycPending:      u.kycPending      || 0,
        kycInReview:     u.kycInReview     || 0,
        kycRejected:     u.kycRejected     || 0,
        kycNotSubmitted: u.kycNotSubmitted || 0,
        today:           u.today           || 0,
      },
      merchantStats: {
        total:      m.total      || 0,
        active:     m.active     || 0,
        inactive:   m.inactive   || 0,
        whitelabel: m.whitelabel || 0,
      },
      cardStats: {
        total:         c.total         || 0,
        active:        c.active        || 0,
        frozen:        c.frozen        || 0,
        cancelled:     c.cancelled     || 0,
        other:         c.other         || 0,
        virtualCount:  c.virtualCount  || 0,
        physicalCount: c.physicalCount || 0,
        totalBalance:  c.totalBalance  || 0,
      },
      physPool: {
        total:       p.total       || 0,
        used:        p.used        || 0,
        available:   p.available   || 0,
        preAssigned: p.preAssigned || 0,
      },
      depositStats: {
        total:        d.total        || 0,
        completed:    d.completed    || 0,
        pending:      d.pending      || 0,
        rejected:     d.rejected     || 0,
        totalAmount:  d.totalAmount  || 0,
        manualCount:  d.manualCount  || 0,
        manualAmount: d.manualAmount || 0,
        autoCount:    d.autoCount    || 0,
        autoAmount:   d.autoAmount   || 0,
        todayCount:   d.todayCount   || 0,
        todayAmount:  d.todayAmount  || 0,
      },
      withdrawalStats: {
        total:       w.total       || 0,
        pending:     w.pending     || 0,
        completed:   w.completed   || 0,
        rejected:    w.rejected    || 0,
        totalAmount: w.totalAmount || 0,
      },
      commissionStats: {
        totalEarned:       com.totalEarned       || 0,
        depositCommission: com.depositCommission || 0,
        cardCommission:    com.cardCommission    || 0,
        count:             com.count             || 0,
      },
      cardIssuanceFees: cardIssuanceFeesAgg[0]?.total || 0,
      autoDeposits24h,
      recentUsers,
      recentTxns,
      recentCards,
      recentMerchants,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/users/stats
exports.userStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [total, active, blocked, todayCount, kycApproved, kycPending, kycInReview, kycRejected] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isBlocked: false }),
      User.countDocuments({ isBlocked: true }),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ kycStatus: 'approved' }),
      User.countDocuments({ kycStatus: 'pending' }),
      User.countDocuments({ kycStatus: 'in_review' }),
      User.countDocuments({ kycStatus: { $in: [KYC_STATUS.REJECTED, KYC_STATUS.NOT_SUBMITTED] } }),
    ]);
    res.json({
      success: true,
      stats: { total, active, blocked, today: todayCount },
      kyc: { approved: kycApproved, pending: kycPending, inReview: kycInReview, rejected: kycRejected },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/users
exports.listUsers = async (req, res) => {
  try {
    const {
      page         = 1,
      limit        = 20,
      search,
      kycStatus,
      status,
      merchantId,
      twoFactor,        // 'on' | 'off' — filter by 2FA state
      country,          // ISO2 (e.g. 'IN')
      dateFrom,         // ISO date string — joined >= dateFrom
      dateTo,           // ISO date string — joined <= dateTo
    } = req.query;

    const filter = {};

    // Search across more fields — name, firstName, lastName, email, phone, mobile, country
    if (search && String(search).trim()) {
      const q = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(q, 'i');
      filter.$or = [
        { name:        re },
        { firstName:   re },
        { lastName:    re },
        { email:       re },
        { phone:       re },
        { mobile:      re },
        { country:     re },
        { countryName: re },
      ];
    }

    // KYC status — pass through (in_review supported once schema enum allows it)
    if (kycStatus) filter.kycStatus = kycStatus;

    // Block / active state
    if (status === 'blocked') filter.isBlocked = true;
    else if (status === 'active') filter.isBlocked = false;

    // Merchant filter — accept 'none' for null, otherwise valid ObjectId
    if (merchantId) {
      if (merchantId === 'none' || merchantId === 'null') {
        filter.merchantId = null;
      } else if (mongoose.Types.ObjectId.isValid(merchantId)) {
        filter.merchantId = new mongoose.Types.ObjectId(merchantId);
      }
      // else: invalid id → silently ignore so the page still loads
    }

    // 2FA on/off
    if (twoFactor === 'on')  filter.twoFactorEnabled = true;
    if (twoFactor === 'off') filter.twoFactorEnabled = false;

    // Country (ISO2 exact match, case-insensitive)
    if (country && String(country).trim()) {
      filter.country = new RegExp(`^${String(country).trim()}$`, 'i');
    }

    // Joined date range
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));

    const [users, total] = await Promise.all([
      User.find(filter).select('-password -twoFactorSecret')
        .populate('merchantId', 'name')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      User.countDocuments(filter),
    ]);

    const userIds = users.map(u => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } }).select('userId balance');
    const walletMap = {};
    wallets.forEach(w => { walletMap[w.userId.toString()] = w.balance; });

    const enriched = users.map(u => ({
      ...u.toObject(),
      walletBalance: walletMap[u._id.toString()] ?? 0,
    }));

    res.json({ success: true, users: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[listUsers] error:', err);
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/users/:id/login-as
exports.loginAsUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -twoFactorSecret');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    // Embed the originating admin in the JWT so any audit row written during
    // the impersonated session attributes the action back to the real actor.
    // authMiddleware reads actorAdminId and exposes req.impersonatedBy.
    const token = jwt.sign(
      { id: user._id, actorAdminId: String(req.admin?._id || ''), purpose: 'impersonation' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    writeAudit(req, {
      action: 'session.impersonateUser',
      targetType: 'User',
      targetId: user._id,
      payload: { userEmail: user.email },
    });
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, kycStatus: user.kycStatus } });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/users/:id
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -twoFactorSecret')
      .populate('merchantId', 'name')
      .populate('kycReviewedBy', 'name email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const wallet = await Wallet.findOne({ userId: user._id });

    const obj = user.toObject();
    const [front, back, selfie] = await Promise.all([
      presignKyc(obj.kycDocFront),
      presignKyc(obj.kycDocBack),
      presignKyc(obj.kycSelfie),
    ]);
    obj.kycDocFront = front;
    obj.kycDocBack  = back;
    obj.kycSelfie   = selfie;

    res.json({ success: true, user: obj, wallet });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id
exports.updateUser = async (req, res) => {
  try {
    const ALLOWED = [
      'name', 'firstName', 'lastName', 'email',
      'gender', 'birthday',
      'country', 'countryName',
      'phone', 'areaCode', 'mobile',
      'town', 'address', 'postCode',
    ];

    const updates = {};
    for (const k of ALLOWED) {
      if (k in req.body) updates[k] = req.body[k];
    }

    const REQUIRED_NON_EMPTY = new Set(['name', 'email']);
    for (const k of Object.keys(updates)) {
      if (typeof updates[k] === 'string') {
        const trimmed = updates[k].trim();
        if (trimmed === '') {
          if (REQUIRED_NON_EMPTY.has(k)) {
            return res.status(400).json({ success: false, message: `${k} is required` });
          }
          updates[k] = null;
        } else {
          updates[k] = trimmed;
        }
      }
    }

    if ('email' in updates && updates.email) {
      updates.email = String(updates.email).toLowerCase();
      const exists = await User.findOne({ email: updates.email, _id: { $ne: req.params.id } }).select('_id');
      if (exists) return res.status(400).json({ success: false, message: 'Email already in use' });
    }

    if ('birthday' in updates && updates.birthday) {
      const d = new Date(updates.birthday);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid birthday' });
      updates.birthday = d;
    }

    if ('country' in updates && updates.country) {
      updates.country = String(updates.country).toUpperCase().slice(0, 2);
    }

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
      .select('-password -twoFactorSecret')
      .populate('merchantId', 'name')
      .populate('kycReviewedBy', 'name email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, message: 'User updated', user });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/block
exports.blockUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isBlocked: true });
    res.json({ success: true, message: 'User blocked' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/unblock
exports.unblockUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isBlocked: false });
    res.json({ success: true, message: 'User unblocked' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/kyc
exports.updateKyc = async (req, res) => {
  try {
    const { kycStatus, kycRejectReason, kycReviewNote } = req.body;
    const note = kycReviewNote || kycRejectReason || null;
    await User.findByIdAndUpdate(req.params.id, {
      kycStatus,
      kycRejectReason: kycStatus === 'rejected' ? (kycRejectReason || note) : null,
      kycReviewNote: note,
      kycReviewedBy: req.admin?._id || null,
      kycReviewedAt: new Date(),
    });

    writeAudit(req, {
      action: 'kyc.update',
      targetType: 'User',
      targetId: req.params.id,
      payload: { kycStatus, note },
    });

    res.json({ success: true, message: `KYC ${kycStatus}` });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/holder-id
// POST /admin/users/:id/add-balance
const ADMIN_ADD_BALANCE_MAX = 1_000_000;
exports.addWalletBalance = async (req, res) => {
  try {
    const notes = req.body.notes || null;
    let amount;
    try {
      amount = toMoney(req.body.amount, 'amount');
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }
    if (amount <= 0) return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    if (amount > ADMIN_ADD_BALANCE_MAX) {
      return res.status(400).json({ success: false, message: `Amount exceeds maximum (${ADMIN_ADD_BALANCE_MAX})` });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.params.id },
      { $inc: { balance: amount } },
      { new: true }
    );
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    try {
      await WalletTransaction.create({
        userId        : req.params.id,
        walletId      : wallet._id,
        type          : 'card_deposit',
        amount,
        status        : 'completed',
        transactionId : 'ADMIN-' + crypto.randomBytes(8).toString('hex').toUpperCase(),
        notes         : notes || `Manual credit by admin (${req.admin?.email || req.admin?._id || 'system'})`,
        completedAt   : new Date(),
      });
    } catch (e) {
      console.error('[addWalletBalance] WalletTransaction write failed userId=%s amount=%s: %s', req.params.id, amount, e.message);
    }

    writeAudit(req, {
      action: 'wallet.credit',
      targetType: 'User',
      targetId: req.params.id,
      payload: { amount, newBalance: wallet.balance, notes },
    });

    res.json({ success: true, message: 'Balance added', newBalance: wallet.balance });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/transactions/stats
exports.transactionStats = async (req, res) => {
  try {
    const DONE = { status: 'completed' };
    const [total, completed, pending, rejectedFailed, manualAgg, autoAgg, cardIssuanceAgg, cardDepositAgg, completedAmtAgg] = await Promise.all([
      WalletTransaction.countDocuments(),
      WalletTransaction.countDocuments({ status: 'completed' }),
      WalletTransaction.countDocuments({ status: 'pending' }),
      WalletTransaction.countDocuments({ status: { $in: [TRANSACTION_STATUS.REJECTED, TRANSACTION_STATUS.FAILED] } }),
      WalletTransaction.aggregate([{ $match: { type: 'deposit', transactionId: /^ADMIN-/i, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'deposit', transactionId: /^AUTO-/i,  status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'card_issuance', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'card_deposit',  status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);

    res.json({
      success: true,
      total, completed, pending, rejectedFailed,
      completedAmount: completedAmtAgg[0]?.total || 0,
      manualDeposits: { amount: manualAgg[0]?.total       || 0, count: manualAgg[0]?.count       || 0 },
      autoDeposits:   { amount: autoAgg[0]?.total         || 0, count: autoAgg[0]?.count         || 0 },
      cardIssuance:   { amount: cardIssuanceAgg[0]?.total || 0, count: cardIssuanceAgg[0]?.count || 0 },
      cardDeposit:    { amount: cardDepositAgg[0]?.total  || 0, count: cardDepositAgg[0]?.count  || 0 },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/transactions
exports.listTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status, search } = req.query;
    const filter = {};
    if (type)   filter.type   = type;
    if (status) filter.status = status;

    if (search) {
      const re = new RegExp(search, 'i');
      const matchingUsers = await User.find({ $or: [{ name: re }, { email: re }] }).select('_id').lean();
      const userIds = matchingUsers.map(u => u._id);
      filter.$or = [
        { transactionId: re },
        { txHash: re },
        { notes: re },
        { wsbOrderNo: re },
        ...(userIds.length ? [{ userId: { $in: userIds } }] : []),
      ];
    }

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      WalletTransaction.countDocuments(filter),
    ]);
    res.json({ success: true, transactions, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/deposits/stats
exports.depositStats = async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const DONE = { $in: ['confirmed', 'completed'] };

    const [total, completed, pending, rejected, manualAgg, autoAgg, todayAgg, completedAmountAgg] = await Promise.all([
      Deposit.countDocuments(),
      Deposit.countDocuments({ status: DONE }),
      Deposit.countDocuments({ status: 'pending' }),
      Deposit.countDocuments({ status: 'rejected' }),
      Deposit.aggregate([{ $match: { source: 'manual', status: DONE } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Deposit.aggregate([{ $match: { source: 'auto',   status: DONE } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Deposit.aggregate([{ $match: { createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Deposit.aggregate([{ $match: { status: DONE } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);

    const trc20Wallet = await HotWallet.findOne({ chain: 'TRC20', isActive: true }).select('address');
    const bep20Wallet = await HotWallet.findOne({ chain: 'BEP20', isActive: true }).select('address');

    res.json({
      success: true,
      total, completed, pending, rejected,
      manual: { amount: manualAgg[0]?.total || 0, count: manualAgg[0]?.count || 0 },
      auto:   { amount: autoAgg[0]?.total   || 0, count: autoAgg[0]?.count   || 0 },
      today:  { amount: todayAgg[0]?.total  || 0, count: todayAgg[0]?.count  || 0 },
      completedAmount: completedAmountAgg[0]?.total || 0,
      trc20Address: trc20Wallet?.address || null,
      bep20Address: bep20Wallet?.address || null,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/deposits  (manual admin deposit)
const ADMIN_MANUAL_DEPOSIT_MAX = 1_000_000;
exports.createManualDeposit = async (req, res) => {
  try {
    const { userId, notes } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(422).json({ success: false, message: 'userId is required' });
    }
    let amount;
    try {
      amount = toMoney(req.body.amount, 'amount');
    } catch (e) {
      if (e instanceof MoneyError) return res.status(422).json({ success: false, message: e.message });
      throw e;
    }
    if (amount <= 0) {
      return res.status(422).json({ success: false, message: 'amount must be a positive finite number' });
    }
    if (amount > ADMIN_MANUAL_DEPOSIT_MAX) {
      return res.status(422).json({ success: false, message: `amount exceeds maximum (${ADMIN_MANUAL_DEPOSIT_MAX})` });
    }

    const user = await User.findById(userId).select('name email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Use crypto.randomBytes for high-entropy identifiers. The previous
    // `ts.toString(16).slice(-9)` carried only 36 bits of entropy — two admin
    // clicks in the same millisecond could collide on WalletTransaction's
    // unique transactionId index and 500.
    const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
    const txHash = `ADMIN-${Date.now().toString(36).toUpperCase()}-${rand}`;
    const transactionId = `ADMIN-${rand}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const deposit = await Deposit.create({
      userId,
      amount,
      source: 'manual',
      status: 'completed',
      txHash,
      transactionId,
      notes: notes || 'Manually added by admin.',
      creditedAt: new Date(),
    });

    await Wallet.findOneAndUpdate({ userId }, { $inc: { balance: amount } }, { upsert: false });

    writeAudit(req, {
      action: 'deposit.createManual',
      targetType: 'Deposit',
      targetId: deposit._id,
      payload: { userId, amount, txHash, notes: notes || null },
    });

    res.status(201).json({ success: true, deposit });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/deposits
exports.listDeposits = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, chain, source } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (chain)  filter.chain  = chain;
    if (source) filter.source = source;

    const [deposits, total] = await Promise.all([
      Deposit.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Deposit.countDocuments(filter),
    ]);
    res.json({ success: true, deposits, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/deposits/:id/approve
exports.approveDeposit = async (req, res) => {
  try {
    const { amount } = req.body;
    // Peek (read-only) to know current state for messaging and to compute
    // creditAmount when caller omits it. The actual state transition below
    // is an atomic compare-and-set; this read is not load-bearing.
    const current = await Deposit.findById(req.params.id);
    if (!current) return res.status(404).json({ success: false, message: 'Deposit not found' });
    if (current.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending deposits can be approved' });

    let creditAmount;
    try {
      creditAmount = toMoney(
        amount !== undefined && amount !== null && amount !== '' ? amount : current.amount,
        'creditAmount',
      );
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }
    if (creditAmount <= 0) return res.status(400).json({ success: false, message: 'creditAmount must be positive' });

    // Atomic transition: only the first concurrent click wins. Subsequent
    // duplicate approves see modifiedCount=0 and bail before crediting.
    const deposit = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      {
        $set: {
          status: 'completed',
          amount: creditAmount,
          creditedAt: new Date(),
          notes: (current.notes ? current.notes + ' ' : '') + 'Approved by admin.',
        },
      },
      { new: true },
    );
    if (!deposit) return res.status(409).json({ success: false, message: 'Deposit already actioned' });

    await Wallet.findOneAndUpdate({ userId: deposit.userId }, { $inc: { balance: creditAmount } });
    if (deposit.txHash) await WalletTransaction.findOneAndUpdate({ txHash: deposit.txHash }, { status: 'completed', completedAt: new Date() });

    writeAudit(req, {
      action: 'deposit.approve',
      targetType: 'Deposit',
      targetId: deposit._id,
      payload: { userId: deposit.userId, amount: creditAmount, txHash: deposit.txHash || null },
    });

    res.json({ success: true, message: `Deposit of ${creditAmount.toFixed(2)} USDT approved and credited` });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/deposits/:id/reject
exports.rejectDeposit = async (req, res) => {
  try {
    const { reason } = req.body;
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    if (deposit.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending deposits can be rejected' });

    deposit.status = 'rejected';
    deposit.rejectedAt = new Date();
    deposit.rejectionReason = reason || null;
    deposit.notes = (deposit.notes ? deposit.notes + ' ' : '') + 'Rejected by admin.';
    await deposit.save();

    if (deposit.txHash) await WalletTransaction.findOneAndUpdate({ txHash: deposit.txHash }, { status: 'rejected' });

    writeAudit(req, {
      action: 'deposit.reject',
      targetType: 'Deposit',
      targetId: deposit._id,
      payload: { userId: deposit.userId, amount: deposit.amount, reason: deposit.rejectionReason },
    });

    res.json({ success: true, message: 'Deposit rejected' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/deposits/expire-stale  body: { olderThanDays?: number, dryRun?: boolean }
//
// Marks manual `pending` Deposit rows older than `olderThanDays` (default 30)
// as `rejected` with reason=`expired`. Audit trail is preserved — no rows
// are deleted. Auto-source rows are left alone because they are normally
// short-lived (created already-confirmed by checkDeposits) and an unconfirmed
// auto row indicates a Cryptrum-side mismatch worth a human look.
exports.expireStaleDeposits = async (req, res) => {
  try {
    const days   = Number(req.body.olderThanDays ?? 30);
    const dryRun = Boolean(req.body.dryRun);
    if (!Number.isFinite(days) || days < 1) {
      return res.status(400).json({ success: false, message: 'olderThanDays must be >= 1' });
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filter = {
      status:    DEPOSIT_STATUS.PENDING,
      source:    'manual',
      createdAt: { $lt: cutoff },
    };

    if (dryRun) {
      const count = await Deposit.countDocuments(filter);
      return res.json({ success: true, dryRun: true, wouldExpire: count, cutoff });
    }

    const now = new Date();
    const result = await Deposit.updateMany(filter, {
      $set: {
        status:          DEPOSIT_STATUS.REJECTED,
        rejectedAt:      now,
        rejectionReason: 'expired',
      },
    });

    writeAudit(req, {
      action: 'deposit.expire-stale',
      targetType: 'Deposit',
      payload: { olderThanDays: days, cutoff, matched: result.matchedCount, modified: result.modifiedCount },
    });

    res.json({ success: true, expired: result.modifiedCount, matched: result.matchedCount, cutoff });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/withdrawals/stats
exports.withdrawalStats = async (req, res) => {
  try {
    const byStatus = await Withdrawal.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);

    const s = {
      pending:    { count: 0, amount: 0 },
      approved:   { count: 0, amount: 0 },
      processing: { count: 0, amount: 0 },
      completed:  { count: 0, amount: 0 },
      rejected:   { count: 0, amount: 0 },
      failed:     { count: 0, amount: 0 },
    };
    for (const r of byStatus) if (s[r._id]) s[r._id] = { count: r.count, amount: r.amount };

    // Business treats approved/processing/completed as the same final state
    const approvedCount  = s.approved.count + s.processing.count + s.completed.count;
    const approvedAmount = s.approved.amount + s.processing.amount + s.completed.amount;
    const total = s.pending.count + approvedCount + s.rejected.count + s.failed.count;

    res.json({
      success: true,
      total,
      pending:        s.pending.count,
      approved:       approvedCount,
      rejected:       s.rejected.count + s.failed.count,
      pendingAmount:  s.pending.amount,
      approvedAmount,
      rejectedAmount: s.rejected.amount + s.failed.amount,
      // backward-compat aliases (kept for any older UI still consuming them)
      processing:        0,
      completed:         approvedCount,
      processingAmount:  0,
      completedAmount:   approvedAmount,
      inFlightAmount:    0,
      approvedProcessing: approvedCount,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/withdrawals
exports.listWithdrawals = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Withdrawal.countDocuments(filter),
    ]);
    res.json({ success: true, withdrawals, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Find the WalletTransaction linked to a withdrawal (uses referenceId; falls back to
// matching by user + type=withdraw + amount + pending for older records without a link).
async function findWithdrawalTxn(withdrawal) {
  const byRef = await WalletTransaction.findOne({ referenceId: withdrawal._id.toString(), type: 'withdraw' });
  if (byRef) return byRef;
  return WalletTransaction.findOne({
    userId: withdrawal.userId,
    type: 'withdraw',
    amount: withdrawal.amount,
    status: 'pending',
  }).sort({ createdAt: -1 });
}

// PUT /admin/withdrawals/:id/approve
exports.approveWithdrawal = async (req, res) => {
  try {
    const cryptrum = require('../../services/CryptrumService');
    const { validateAmount, validateAddress, familyForMethod } = require('../../lib/cryptoValidation');

    // Atomic transition: pending → approved. Two concurrent admin clicks both
    // hit this; only one matches { status: 'pending' } and proceeds. We do
    // this BEFORE calling Cryptrum so the slot is reserved — if Cryptrum
    // fails we revert it.
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'approved', approvedBy: req.admin?._id || null } },
      { new: true },
    );
    if (!withdrawal) {
      const exists = await Withdrawal.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
      return res.status(409).json({ success: false, message: 'Withdrawal already actioned' });
    }

    // Helper: revert the row to pending so the admin can fix / retry.
    const revert = (note) => Withdrawal.updateOne(
      { _id: withdrawal._id },
      { $set: { status: 'pending', approvedBy: null, ...(note ? { rejectionReason: note } : {}) } },
    );

    if (!withdrawal.paymentMethodId) {
      await revert();
      return res.status(400).json({
        success: false,
        message: 'This withdrawal has no Cryptrum paymentMethodId — cannot push to provider.',
      });
    }

    // Re-validate amount, address, and network against current Cryptrum state.
    // Catches: provider disabled the network, address formats changed, stale data.
    const amtRes = validateAmount(withdrawal.amount);
    if (!amtRes.ok) {
      await revert(`Invalid amount: ${amtRes.error}`);
      return res.status(400).json({ success: false, message: `Cannot push to provider — ${amtRes.error}` });
    }

    let method;
    try {
      const { items } = await cryptrum.getPaymentMethods('withdraw');
      method = items.find(m => m.id === withdrawal.paymentMethodId);
    } catch (e) {
      await revert();
      return res.status(e.status || 502).json({ success: false, message: e.message || 'Failed to verify network with provider' });
    }
    if (!method) {
      await revert();
      return res.status(400).json({ success: false, message: 'Cryptrum no longer recognises this paymentMethodId' });
    }
    if (!method.withdrawEnabled) {
      await revert();
      return res.status(400).json({ success: false, message: `Withdrawals are currently disabled on ${method.networkName}` });
    }

    const addrRes = validateAddress(withdrawal.toAddress, {
      chain:  method.networkName,
      family: familyForMethod(method),
    });
    if (!addrRes.ok) {
      await revert(`Invalid address: ${addrRes.error}`);
      return res.status(400).json({ success: false, message: `Cannot push to provider — ${addrRes.error}` });
    }

    let cryptrumResp;
    try {
      cryptrumResp = await cryptrum.createWithdraw({
        referenceId:     withdrawal._id.toString(),
        paymentMethodId: withdrawal.paymentMethodId,
        amount:          amtRes.amount,
        toAddress:       addrRes.address,
      });
    } catch (e) {
      // Provider failed — revert to pending so the admin can retry / reject.
      await Withdrawal.updateOne({ _id: withdrawal._id }, { $set: { status: 'pending', approvedBy: null } });
      console.error('[Cryptrum] approveWithdrawal push failed:', e.message);
      return res.status(e.status || 502).json({
        success: false,
        message: e.message || 'Cryptrum rejected the withdrawal — left as pending so you can retry.',
      });
    }

    withdrawal.cryptrumCode = cryptrumResp.withdrawCode || null;
    await withdrawal.save();

    // Atomic, precondition-guarded lock release. Skip if not enough locked
    // (historical row without a matching lock); never let `locked` go negative.
    await Wallet.findOneAndUpdate(
      { userId: withdrawal.userId, locked: { $gte: withdrawal.amount } },
      { $inc: { locked: -withdrawal.amount } },
    );

    const txn = await findWithdrawalTxn(withdrawal);
    if (txn) {
      txn.status = 'approved';
      txn.referenceId = txn.referenceId || withdrawal._id.toString();
      txn.completedAt = new Date();
      await txn.save();
    }

    writeAudit(req, {
      action: 'withdrawal.approve',
      targetType: 'Withdrawal',
      targetId: withdrawal._id,
      payload: {
        userId: withdrawal.userId, amount: withdrawal.amount, chain: withdrawal.chain,
        toAddress: withdrawal.toAddress, cryptrumCode: withdrawal.cryptrumCode,
      },
    });

    res.json({
      success: true,
      message: `Withdrawal of $${withdrawal.amount.toFixed(2)} approved and submitted to Cryptrum.`,
      cryptrumCode: withdrawal.cryptrumCode,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/withdrawals/:id/reject
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;

    // Atomic transition: pending → rejected. Refund only fires if this call
    // is the one that flipped the state, so two concurrent reject clicks
    // can never refund twice.
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: reason || 'Rejected by admin.' } },
      { new: true },
    );
    if (!withdrawal) {
      const exists = await Withdrawal.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
      return res.status(409).json({ success: false, message: 'Only pending withdrawals can be rejected' });
    }

    // Refund: move locked → available balance (matches PHP). Preserves the
    // existing clamp behaviour when the lock is partial / missing.
    const wallet = await Wallet.findOne({ userId: withdrawal.userId });
    if (wallet) {
      const lockedDec = Math.min(wallet.locked, withdrawal.amount);
      await Wallet.findOneAndUpdate(
        { userId: withdrawal.userId },
        { $inc: { balance: withdrawal.amount, locked: -lockedDec } },
      );
    }

    const txn = await findWithdrawalTxn(withdrawal);
    if (txn) {
      txn.status = 'rejected';
      txn.referenceId = txn.referenceId || withdrawal._id.toString();
      txn.notes = withdrawal.rejectionReason;
      await txn.save();
    }

    writeAudit(req, {
      action: 'withdrawal.reject',
      targetType: 'Withdrawal',
      targetId: withdrawal._id,
      payload: { userId: withdrawal.userId, amount: withdrawal.amount, reason: withdrawal.rejectionReason },
    });

    res.json({ success: true, message: `Withdrawal rejected. $${withdrawal.amount.toFixed(2)} USDT refunded.` });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/commission-settings
exports.getCommissionSettings = async (req, res) => {
  try {
    const TYPES = ['deposit', 'withdrawal', 'card_issuance_virtual', 'card_issuance_physical', 'card_deposit', 'card_withdrawal'];

    // Ensure all 4 types exist (firstOrCreate)
    await Promise.all(TYPES.map(type =>
      CommissionSetting.findOneAndUpdate(
        { type },
        { $setOnInsert: { rateType: 'percentage', rate: 0 } },
        { upsert: true, new: true },
      )
    ));

    const [settings, virtualMin, physicalMin] = await Promise.all([
      CommissionSetting.find({ type: { $in: TYPES } }),
      AppSetting.findOne({ key: 'virtual_card_min_deposit' }),
      AppSetting.findOne({ key: 'physical_card_min_deposit' }),
    ]);

    res.json({
      success: true,
      settings,
      virtualCardMinDeposit:  parseFloat(virtualMin?.value  || '50'),
      physicalCardMinDeposit: parseFloat(physicalMin?.value || '50'),
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/commission-settings
exports.updateCommissionSettings = async (req, res) => {
  try {
    const { settings, virtualCardMinDeposit, physicalCardMinDeposit } = req.body;

    const ops = [];

    if (Array.isArray(settings)) {
      for (const s of settings) {
        const rateType = s.rateType === 'fixed' ? 'fixed' : 'percentage';
        const rate = Number(s.rate);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(422).json({ success: false, message: `Invalid rate for ${s.type}: must be a non-negative finite number.` });
        }
        const cap = rateType === 'percentage' ? 100 : 10000;
        if (rate > cap) {
          return res.status(422).json({ success: false, message: `Rate ${rate} exceeds maximum (${cap}) for ${rateType} commission on ${s.type}.` });
        }
        ops.push(
          CommissionSetting.findOneAndUpdate(
            { type: s.type },
            { rateType, rate },
            { upsert: true, new: true, runValidators: true },
          )
        );
      }
    }

    if (virtualCardMinDeposit !== undefined) {
      ops.push(AppSetting.findOneAndUpdate(
        { key: 'virtual_card_min_deposit' },
        { value: String(Number(virtualCardMinDeposit)) },
        { upsert: true },
      ));
    }

    if (physicalCardMinDeposit !== undefined) {
      ops.push(AppSetting.findOneAndUpdate(
        { key: 'physical_card_min_deposit' },
        { value: String(Number(physicalCardMinDeposit)) },
        { upsert: true },
      ));
    }

    await Promise.all(ops);
    res.json({ success: true, message: 'Commission settings saved successfully.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/users/:id/commission
exports.getUserCommission = async (req, res) => {
  try {
    const settings = await UserCommissionSetting.find({ userId: req.params.id });
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/commission
exports.updateUserCommission = async (req, res) => {
  try {
    const { type } = req.body;
    if (typeof type !== 'string' || !type) {
      return res.status(422).json({ success: false, message: 'type is required' });
    }
    const rateType = req.body.rateType === 'fixed' ? 'fixed' : 'percentage';
    const rate = Number(req.body.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(422).json({ success: false, message: 'rate must be a non-negative finite number' });
    }
    const cap = rateType === 'percentage' ? 100 : 10000;
    if (rate > cap) {
      return res.status(422).json({ success: false, message: `rate exceeds maximum (${cap}) for ${rateType} commission` });
    }

    await UserCommissionSetting.findOneAndUpdate(
      { userId: req.params.id, type },
      { rateType, rate },
      { upsert: true, new: true, runValidators: true },
    );
    res.json({ success: true, message: 'User commission updated' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/commission-history
exports.commissionHistory = async (req, res) => {
  try {
    const { page = 1, limit = 25, type, userId } = req.query;
    const filter = {};
    if (type)   filter.type   = type;
    if (userId) filter.userId = userId;

    const [records, total, totalsAgg, grandTotalAgg] = await Promise.all([
      CommissionLedger.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      CommissionLedger.countDocuments(filter),
      // Always aggregate across ALL records (not filtered) for the stat cards
      CommissionLedger.aggregate([
        { $group: { _id: '$type', total: { $sum: '$commissionAmount' } } },
      ]),
      CommissionLedger.aggregate([
        { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
      ]),
    ]);

    const totals = {};
    totalsAgg.forEach(t => { totals[t._id] = t.total; });

    res.json({
      success: true,
      records,
      total,
      grandTotal: grandTotalAgg[0]?.total || 0,
      totals,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/hot-wallets
exports.listHotWallets = async (req, res) => {
  try {
    const wallets = await HotWallet.find().sort({ derivationIndex: 1 });
    res.json({ success: true, wallets });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/hot-wallets
exports.createHotWallet = async (req, res) => {
  try {
    const wallet = await HotWallet.create(req.body);
    res.status(201).json({ success: true, wallet });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/hot-wallets/:id/toggle
exports.toggleHotWallet = async (req, res) => {
  try {
    const wallet = await HotWallet.findById(req.params.id);
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
    wallet.enabled = !wallet.enabled;
    await wallet.save();
    res.json({ success: true, enabled: wallet.enabled });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/cards
exports.listCards = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, cardType } = req.query;
    const filter = {};
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/physical-card-numbers
exports.listPhysicalCardNumbers = async (req, res) => {
  try {
    const { page = 1, limit = 50, statusFilter, merchantFilter } = req.query;
    const filter = {};

    if (merchantFilter === 'general')      filter.merchantId = null;
    else if (merchantFilter)               filter.merchantId = merchantFilter;

    if (statusFilter === 'available')      filter.isUsed = false;
    else if (statusFilter === 'used')      filter.isUsed = true;

    const [cards, total, stats] = await Promise.all([
      PhysicalCardNumber.find(filter)
        .populate('merchantId', 'name')
        .populate('preAssignedUserId', 'name email')
        .populate({ path: 'cardId', select: 'status cardNo userId', populate: { path: 'userId', select: 'name email' } })
        .sort({ isUsed: 1, createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      PhysicalCardNumber.countDocuments(filter),
      Promise.all([
        PhysicalCardNumber.countDocuments({}),
        PhysicalCardNumber.countDocuments({ isUsed: false }),
        PhysicalCardNumber.countDocuments({ isUsed: true }),
      ]).then(([t, a, u]) => ({ total: t, available: a, used: u })),
    ]);
    res.json({ success: true, cards, total, stats });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/physical-card-numbers
// Accepts: { cardNumbers: "string with newlines/commas/semicolons" | string[], notes?, merchantId? }
exports.addPhysicalCardNumbers = async (req, res) => {
  try {
    const { cardNumbers, notes, merchantId } = req.body;
    let raw = [];
    if (Array.isArray(cardNumbers)) raw = cardNumbers;
    else if (typeof cardNumbers === 'string') raw = cardNumbers.split(/[\r\n,;]+/);
    else return res.status(400).json({ success: false, message: 'cardNumbers is required' });

    let added = 0, skipped = 0;
    for (const entry of raw) {
      const num = String(entry || '').replace(/\s+/g, '').trim();
      if (!num) continue;
      if (!/^\d{13,19}$/.test(num)) { skipped++; continue; }
      const exists = await PhysicalCardNumber.exists({ cardNumber: num });
      if (exists) { skipped++; continue; }
      await PhysicalCardNumber.create({
        cardNumber: num,
        notes: notes || null,
        merchantId: merchantId || null,
      });
      added++;
    }

    let message = `${added} card number(s) added.`;
    if (skipped > 0) message += ` ${skipped} skipped (invalid or duplicate).`;
    res.status(201).json({ success: true, message, added, skipped });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// DELETE /admin/physical-card-numbers/:id
exports.deletePhysicalCardNumber = async (req, res) => {
  try {
    const num = await PhysicalCardNumber.findById(req.params.id);
    if (!num) return res.status(404).json({ success: false, message: 'Card number not found' });
    if (num.isUsed) {
      return res.status(400).json({ success: false, message: 'Cannot delete a card number that has already been assigned.' });
    }
    await num.deleteOne();
    res.json({ success: true, message: 'Card number deleted.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/physical-card-numbers/:id/assign-merchant
exports.assignCardToMerchant = async (req, res) => {
  try {
    const { merchantId } = req.body;
    const num = await PhysicalCardNumber.findById(req.params.id);
    if (!num) return res.status(404).json({ success: false, message: 'Card number not found' });
    if (num.isUsed) {
      return res.status(400).json({ success: false, message: 'Cannot reassign a card number that has already been used.' });
    }
    // Clear user pre-assignment whenever the merchant changes (matches PHP behavior).
    num.merchantId = merchantId || null;
    num.preAssignedUserId = null;
    num.preAssignedAt = null;
    await num.save();
    res.json({ success: true, message: 'Card assignment updated.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/physical-card-numbers/:id/pre-assign-user
// Body: { userId?: string, email?: string }
// Empty userId+email clears the pre-assignment.
exports.preAssignUser = async (req, res) => {
  try {
    const { userId, email } = req.body || {};
    const num = await PhysicalCardNumber.findById(req.params.id);
    if (!num) return res.status(404).json({ success: false, message: 'Card number not found' });
    if (num.isUsed) {
      return res.status(400).json({ success: false, message: 'Card number is already in use.' });
    }

    if (!userId && !(email && email.trim())) {
      num.preAssignedUserId = null;
      num.preAssignedAt = null;
      await num.save();
      return res.json({ success: true, message: 'Pre-assignment cleared.', user: null });
    }

    let user = null;
    if (userId) user = await User.findById(userId).select('name email');
    if (!user && email) user = await User.findOne({ email: email.trim() }).select('name email');
    if (!user) return res.status(404).json({ success: false, message: 'No user found.' });

    num.preAssignedUserId = user._id;
    num.preAssignedAt = new Date();
    await num.save();

    res.json({
      success: true,
      message: `Card pre-assigned to ${user.name}.`,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/physical-card-numbers/:id/mark-used
// Body: { email?: string } — if provided, links to that user's pending physical card.
exports.markCardNumberUsed = async (req, res) => {
  try {
    const num = await PhysicalCardNumber.findById(req.params.id);
    if (!num) return res.status(404).json({ success: false, message: 'Card number not found' });
    if (num.isUsed) {
      return res.status(400).json({ success: false, message: 'Already marked as used.' });
    }

    const email = String(req.body?.email || '').trim();
    let cardId = null;
    let info = null;

    if (email) {
      const user = await User.findOne({ email }).select('name email');
      if (!user) return res.status(404).json({ success: false, message: 'No user found with that email.' });

      // Find a physical card for this user: matching card number, or pending/processing with no card number.
      const card = await Card.findOne({
        userId: user._id,
        cardType: 'physical',
        $or: [
          { cardNo: num.cardNumber },
          { status: { $in: [CARD_STATUS.PENDING, CARD_STATUS.PROCESSING] }, cardNo: { $in: [null, ''] } },
        ],
      }).sort({ createdAt: -1 });

      if (card) {
        if (!card.cardNo) {
          card.cardNo = num.cardNumber;
          await card.save();
        }
        cardId = card._id;
      }
      info = `${user.name} (${user.email})`;
    }

    num.isUsed = true;
    num.usedAt = new Date();
    num.cardId = cardId;
    await num.save();

    res.json({
      success: true,
      message: 'Card number marked as used' + (info ? ` and linked to ${info}` : '') + '.',
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/physical-card-numbers/:id/mark-available
// PHP returns 403 — used numbers cannot be flipped back to available.
exports.markCardNumberAvailable = async (req, res) => {
  res.status(403).json({
    success: false,
    message: 'A used card number cannot be marked available again.',
  });
};

// GET /admin/uqpay-api-logs
exports.uqpayApiLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, path, method, status } = req.query;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));

    const filter = {};
    if (path)   filter.path   = { $regex: String(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (method) filter.method = String(method).toUpperCase();
    if (status === 'success') filter.success = true;
    if (status === 'error')   filter.success = false;

    const [logs, total, successCount] = await Promise.all([
      UqpayApiLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      UqpayApiLog.countDocuments(filter),
      UqpayApiLog.countDocuments({ ...filter, success: true }),
    ]);

    const fails = total - successCount;
    res.json({
      success: true,
      logs,
      total,
      page: pageNum,
      limit: limitNum,
      stats: {
        total,
        successful: successCount,
        failed: fails,
        successRate: total > 0 ? Math.round((successCount / total) * 1000) / 10 : 0,
      },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/wallet-service-logs
exports.walletServiceLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, category, level } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (level) filter.level = level;

    const logs = await WalletServiceLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await WalletServiceLog.countDocuments(filter);
    res.json({ success: true, logs, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Admin Users (for 2FA management) ──────────────────────────────────────

// GET /admin/admins
exports.listAdmins = async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const filter = {};
    if (search && String(search).trim()) {
      const re = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { email: re }];
    }

    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));

    const [admins, total] = await Promise.all([
      AdminUser.find(filter)
        .select('-password -twoFactorSecret')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      AdminUser.countDocuments(filter),
    ]);

    res.json({ success: true, admins, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/users/:id/2fa   body: { enabled: boolean }
// Enabling: flag the user so their next login forces TOTP setup.
// Disabling: clear the requirement, the activation flag, and the stored secret.
exports.toggleUser2FA = async (req, res) => {
  try {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    const updates = enabled
      ? { twoFactorRequired: true }
      : { twoFactorRequired: false, twoFactorEnabled: false, twoFactorSecret: null };

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select('-password -twoFactorSecret');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({
      success: true,
      message: enabled ? '2FA required on next login' : '2FA disabled and reset',
      user,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/admins/:id/2fa   body: { enabled: boolean }
exports.toggleAdmin2FA = async (req, res) => {
  try {
    if (req.admin && String(req.admin._id) === String(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Use your own settings to manage your personal 2FA — admins cannot toggle their own from this screen.',
      });
    }

    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    const updates = enabled
      ? { twoFactorRequired: true }
      : { twoFactorRequired: false, twoFactorEnabled: false, twoFactorSecret: null };

    const admin = await AdminUser.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select('-password -twoFactorSecret');
    if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

    writeAudit(req, {
      action: enabled ? 'admin.2fa.require' : 'admin.2fa.disable',
      targetType: 'AdminUser',
      targetId: admin._id,
      payload: { adminEmail: admin.email },
    });

    res.json({
      success: true,
      message: enabled ? '2FA required on next login' : '2FA disabled and reset',
      admin,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/cryptrum/payment-methods?type=deposit|withdraw
exports.cryptrumPaymentMethods = async (req, res) => {
  try {
    const cryptrum = require('../../services/CryptrumService');
    const type = req.query.type === 'withdraw' ? 'withdraw' : 'deposit';
    const { items, imageBaseUrl } = await cryptrum.getPaymentMethods(type);
    res.json({ success: true, type, methods: items, imageBaseUrl });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to load payment methods' });
  }
};

// GET /admin/users/:id/crypto-addresses
exports.listUserCryptoAddresses = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('email name cryptoAddresses');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, userId: user._id, addresses: user.cryptoAddresses || [] });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/users/:id/crypto-addresses   body: { paymentMethodId }
// Pre-issues a Cryptrum deposit address for a user. Idempotent: returns the
// existing address if one is already stored for this paymentMethodId.
exports.createUserCryptoAddress = async (req, res) => {
  try {
    const cryptrum = require('../../services/CryptrumService');
    const paymentMethodId = Number(req.body.paymentMethodId);
    if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ success: false, message: 'paymentMethodId is required' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const existing = (user.cryptoAddresses || []).find(a => a.paymentMethodId === paymentMethodId);
    if (existing && existing.address) {
      return res.json({ success: true, address: existing, cached: true });
    }

    const { items } = await cryptrum.getPaymentMethods('deposit');
    const method = items.find(m => m.id === paymentMethodId);
    if (!method) return res.status(400).json({ success: false, message: 'Unknown payment method' });

    const { address } = await cryptrum.fetchAddress(user._id.toString(), paymentMethodId);
    const entry = {
      paymentMethodId,
      address,
      name:        method.name,
      networkName: method.networkName,
      networkType: method.networkType,
      chainId:     method.chainId,
    };
    user.cryptoAddresses.push(entry);
    await user.save();

    writeAudit(req, {
      action: 'user.crypto-address.create',
      targetType: 'User',
      targetId: user._id,
      payload: { paymentMethodId, networkName: method.networkName, name: method.name },
    });

    res.status(201).json({ success: true, address: entry, cached: false });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to create address' });
  }
};

// GET /admin/users/:id/cryptrum-deposits
//
// Admin view of a user's full Cryptrum deposit-list across every active
// deposit method (not just methods the user has cached) — mirrors the
// user-side `/wallet/cryptrum/deposits/all` simplification so cross-asset /
// cross-family deposits surface here too.
exports.cryptrumDepositsForUser = async (req, res) => {
  try {
    const cryptrum = require('../../services/CryptrumService');
    const user = await User.findById(req.params.id).select('email name');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const uniqueId = user._id.toString();
    const { items } = await cryptrum.getPaymentMethods('deposit');
    const methods = items.filter(m => m.depositEnabled);
    if (methods.length === 0) {
      return res.json({ success: true, deposits: [], user: { _id: user._id, email: user.email, name: user.name } });
    }

    const results = await Promise.allSettled(
      methods.map(m => cryptrum.getDepositList({
        uniqueId,
        paymentMethodId: m.id,
        balanceSync:     1,
      })),
    );

    const flat = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && Array.isArray(r.value.deposits)) {
        for (const dep of r.value.deposits) {
          flat.push({
            ...dep,
            paymentMethodId: methods[i].id,
            chain:           methods[i].networkName,
            asset:           methods[i].name,
          });
        }
      } else if (r.status === 'rejected') {
        console.warn('[admin.cryptrumDepositsForUser] method', methods[i].id, 'failed:', r.reason?.message);
      }
    }

    flat.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({
      success: true,
      deposits: flat,
      user: { _id: user._id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err.message);
    res.status(500).json({ success: false, message: 'Failed to load Cryptrum deposits' });
  }
};

