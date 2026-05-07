const jwt = require('jsonwebtoken');
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
    const user = await User.findById(req.params.id).select('-password -twoFactorSecret').populate('merchantId', 'name');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const wallet = await Wallet.findOne({ userId: user._id });
    res.json({ success: true, user, wallet });
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
    const { kycStatus, kycRejectReason } = req.body;
    await User.findByIdAndUpdate(req.params.id, { kycStatus, kycRejectReason: kycRejectReason || null });
    res.json({ success: true, message: `KYC ${kycStatus}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/users/:id/holder-id
exports.updateHolderId = async (req, res) => {
  try {
    const { wasabiHolderId, wasabiPhysicalHolderId } = req.body;
    await User.findByIdAndUpdate(req.params.id, { wasabiHolderId, wasabiPhysicalHolderId });
    res.json({ success: true, message: 'Holder IDs updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/users/:id/add-balance
exports.addWalletBalance = async (req, res) => {
  try {
    const { amount, notes } = req.body;
    const wallet = await Wallet.findOneAndUpdate({ userId: req.params.id }, { $inc: { balance: amount } }, { new: true });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
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
    const [total, pending, approvedProcessing, completed, rejected, pendingAgg, completedAgg] = await Promise.all([
      Withdrawal.countDocuments(),
      Withdrawal.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: { $in: ['approved', 'processing'] } }),
      Withdrawal.countDocuments({ status: 'completed' }),
      Withdrawal.countDocuments({ status: { $in: ['rejected', 'failed'] } }),
      Withdrawal.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Withdrawal.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);

    res.json({
      success: true,
      total, pending, approvedProcessing, completed, rejected,
      pendingAmount:   pendingAgg[0]?.total   || 0,
      completedAmount: completedAgg[0]?.total  || 0,
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

    res.json({ success: true, message: `Withdrawal of $${withdrawal.amount.toFixed(2)} approved. Queued for on-chain processing.` });
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

    // Also update WalletTransaction if one exists
    if (withdrawal.txHash) {
      await WalletTransaction.findOneAndUpdate(
        { userId: withdrawal.userId, type: 'withdrawal', status: 'pending' },
        { status: 'rejected', notes: 'Rejected by admin. Balance refunded.' },
      );
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
    const { page = 1, limit = 20, isUsed, merchantId } = req.query;
    const filter = {};
    if (isUsed !== undefined) filter.isUsed = isUsed === 'true';
    if (merchantId) filter.merchantId = merchantId;

    const cards = await PhysicalCardNumber.find(filter)
      .populate('merchantId', 'name')
      .populate('preAssignedUserId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await PhysicalCardNumber.countDocuments(filter);
    res.json({ success: true, cards, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/physical-card-numbers
exports.addPhysicalCardNumbers = async (req, res) => {
  try {
    const { cardNumbers, merchantId } = req.body; // cardNumbers: array of strings
    const docs = cardNumbers.map(n => ({ cardNumber: n, merchantId: merchantId || null }));
    await PhysicalCardNumber.insertMany(docs, { ordered: false });
    res.status(201).json({ success: true, message: `${cardNumbers.length} card numbers added` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /admin/physical-card-numbers/:id
exports.deletePhysicalCardNumber = async (req, res) => {
  try {
    await PhysicalCardNumber.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/physical-card-numbers/:id/assign-merchant
exports.assignCardToMerchant = async (req, res) => {
  try {
    const { merchantId } = req.body;
    await PhysicalCardNumber.findByIdAndUpdate(req.params.id, { merchantId });
    res.json({ success: true, message: 'Assigned to merchant' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/physical-card-numbers/:id/pre-assign-user
exports.preAssignUser = async (req, res) => {
  try {
    const { userId } = req.body;
    await PhysicalCardNumber.findByIdAndUpdate(req.params.id, { preAssignedUserId: userId, preAssignedAt: new Date() });
    res.json({ success: true, message: 'Pre-assigned to user' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};
