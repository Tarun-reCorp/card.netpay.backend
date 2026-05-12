const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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
const Merchant = require('../../models/Merchant');

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
    const [totalUsers, totalCards, totalMerchants, pendingDeposits, pendingWithdrawals] = await Promise.all([
      User.countDocuments(),
      Card.countDocuments(),
      Merchant.countDocuments(),
      Deposit.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
    ]);
    res.json({ success: true, stats: { totalUsers, totalCards, totalMerchants, pendingDeposits, pendingWithdrawals } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
      User.countDocuments({ kycStatus: { $in: ['rejected', 'not_submitted'] } }),
    ]);
    res.json({
      success: true,
      stats: { total, active, blocked, today: todayCount },
      kyc: { approved: kycApproved, pending: kycPending, inReview: kycInReview, rejected: kycRejected },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/users
exports.listUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, kycStatus, status, merchantId } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
    if (kycStatus) filter.kycStatus = kycStatus;
    if (status === 'blocked') filter.isBlocked = true;
    if (status === 'active') filter.isBlocked = false;
    if (merchantId) filter.merchantId = merchantId;

    const [users, total] = await Promise.all([
      User.find(filter).select('-password -twoFactorSecret')
        .populate('merchantId', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
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

    res.json({ success: true, users: enriched, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/users/:id/login-as
exports.loginAsUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -twoFactorSecret');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, kycStatus: user.kycStatus } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/users/:id/block
exports.blockUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isBlocked: true });
    res.json({ success: true, message: 'User blocked' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/users/:id/unblock
exports.unblockUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isBlocked: false });
    res.json({ success: true, message: 'User unblocked' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.json({ success: true, message: `KYC ${kycStatus}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/users/:id/holder-id
// POST /admin/users/:id/add-balance
exports.addWalletBalance = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const notes  = req.body.notes || null;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.params.id },
      { $inc: { balance: amount } },
      { new: true }
    );
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    await WalletTransaction.create({
      userId        : req.params.id,
      walletId      : wallet._id,
      type          : 'card_topup',
      amount,
      status        : 'completed',
      transactionId : 'ADMIN-' + crypto.randomBytes(8).toString('hex').toUpperCase(),
      notes         : notes || `Manual credit by admin (${req.admin?.email || req.admin?._id || 'system'})`,
      completedAt   : new Date(),
    });

    res.json({ success: true, message: 'Balance added', newBalance: wallet.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/transactions/stats
exports.transactionStats = async (req, res) => {
  try {
    const DONE = { status: 'completed' };
    const [total, completed, pending, rejectedFailed, manualAgg, autoAgg, cardIssuanceAgg, cardTopupAgg, completedAmtAgg] = await Promise.all([
      WalletTransaction.countDocuments(),
      WalletTransaction.countDocuments({ status: 'completed' }),
      WalletTransaction.countDocuments({ status: 'pending' }),
      WalletTransaction.countDocuments({ status: { $in: ['rejected', 'failed'] } }),
      WalletTransaction.aggregate([{ $match: { type: 'deposit', transactionId: /^ADMIN-/i, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'deposit', transactionId: /^AUTO-/i,  status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'card_issuance', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { type: 'card_topup',    status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      WalletTransaction.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);

    res.json({
      success: true,
      total, completed, pending, rejectedFailed,
      completedAmount: completedAmtAgg[0]?.total || 0,
      manualDeposits: { amount: manualAgg[0]?.total       || 0, count: manualAgg[0]?.count       || 0 },
      autoDeposits:   { amount: autoAgg[0]?.total         || 0, count: autoAgg[0]?.count         || 0 },
      cardIssuance:   { amount: cardIssuanceAgg[0]?.total || 0, count: cardIssuanceAgg[0]?.count || 0 },
      cardTopup:      { amount: cardTopupAgg[0]?.total    || 0, count: cardTopupAgg[0]?.count    || 0 },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/deposits  (manual admin deposit)
exports.createManualDeposit = async (req, res) => {
  try {
    const { userId, amount, notes } = req.body;
    if (!userId || !amount || Number(amount) <= 0)
      return res.status(422).json({ success: false, message: 'userId and a positive amount are required' });

    const user = await User.findById(userId).select('name email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const ts = Date.now();
    const txHash = `ADMIN-${ts.toString(36).toUpperCase()}`;
    const transactionId = `ADMIN-${ts.toString(16).toUpperCase().slice(-9)}`;

    const deposit = await Deposit.create({
      userId,
      amount: Number(amount),
      source: 'manual',
      status: 'completed',
      txHash,
      transactionId,
      notes: notes || 'Manually added by admin.',
      creditedAt: new Date(),
    });

    await Wallet.findOneAndUpdate({ userId }, { $inc: { balance: Number(amount) } }, { upsert: false });

    res.status(201).json({ success: true, deposit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/deposits/:id/approve
exports.approveDeposit = async (req, res) => {
  try {
    const { amount } = req.body;
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    if (deposit.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending deposits can be approved' });

    const creditAmount = amount ? Number(amount) : deposit.amount;
    deposit.status = 'completed';
    deposit.amount = creditAmount;
    deposit.creditedAt = new Date();
    deposit.notes = (deposit.notes ? deposit.notes + ' ' : '') + 'Approved by admin.';
    await deposit.save();

    await Wallet.findOneAndUpdate({ userId: deposit.userId }, { $inc: { balance: creditAmount } });
    if (deposit.txHash) await WalletTransaction.findOneAndUpdate({ txHash: deposit.txHash }, { status: 'completed', completedAt: new Date() });

    res.json({ success: true, message: `Deposit of ${creditAmount.toFixed(2)} USDT approved and credited` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.json({ success: true, message: 'Deposit rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending withdrawals can be approved' });

    withdrawal.status = 'approved';
    withdrawal.approvedBy = req.admin?._id || null;
    await withdrawal.save();

    // Release locked balance (matches PHP: wallet.locked -= amount)
    const wallet = await Wallet.findOne({ userId: withdrawal.userId });
    if (wallet && wallet.locked >= withdrawal.amount) {
      await Wallet.findOneAndUpdate({ userId: withdrawal.userId }, { $inc: { locked: -withdrawal.amount } });
    }

    const txn = await findWithdrawalTxn(withdrawal);
    if (txn) {
      txn.status = 'approved';
      txn.referenceId = txn.referenceId || withdrawal._id.toString();
      txn.completedAt = new Date();
      await txn.save();
    }

    res.json({ success: true, message: `Withdrawal of $${withdrawal.amount.toFixed(2)} approved.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/withdrawals/:id/reject
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending withdrawals can be rejected' });

    withdrawal.status = 'rejected';
    withdrawal.rejectionReason = reason || 'Rejected by admin.';
    await withdrawal.save();

    // Refund: move locked → available balance (matches PHP)
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

    res.json({ success: true, message: `Withdrawal rejected. $${withdrawal.amount.toFixed(2)} USDT refunded.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/commission-settings
exports.getCommissionSettings = async (req, res) => {
  try {
    const TYPES = ['deposit', 'withdrawal', 'card_issuance_virtual', 'card_issuance_physical'];

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
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/commission-settings
exports.updateCommissionSettings = async (req, res) => {
  try {
    const { settings, virtualCardMinDeposit, physicalCardMinDeposit } = req.body;

    const ops = [];

    if (Array.isArray(settings)) {
      for (const s of settings) {
        ops.push(
          CommissionSetting.findOneAndUpdate(
            { type: s.type },
            { rateType: s.rateType, rate: Number(s.rate) },
            { upsert: true, new: true },
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/users/:id/commission
exports.getUserCommission = async (req, res) => {
  try {
    const settings = await UserCommissionSetting.find({ userId: req.params.id });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/users/:id/commission
exports.updateUserCommission = async (req, res) => {
  try {
    const { type, rateType, rate } = req.body;
    await UserCommissionSetting.findOneAndUpdate(
      { userId: req.params.id, type },
      { rateType, rate },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'User commission updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/hot-wallets
exports.listHotWallets = async (req, res) => {
  try {
    const wallets = await HotWallet.find().sort({ derivationIndex: 1 });
    res.json({ success: true, wallets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/hot-wallets
exports.createHotWallet = async (req, res) => {
  try {
    const wallet = await HotWallet.create(req.body);
    res.status(201).json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
          { status: { $in: ['pending', 'processing'] }, cardNo: { $in: [null, ''] } },
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};
