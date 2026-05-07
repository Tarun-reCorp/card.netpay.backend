const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const Card = require('../../models/Card');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
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

// GET /admin/users
exports.listUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, kycStatus, merchantId } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];
    if (kycStatus) filter.kycStatus = kycStatus;
    if (merchantId) filter.merchantId = merchantId;

    const users = await User.find(filter).select('-password -twoFactorSecret')
      .populate('merchantId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await User.countDocuments(filter);
    res.json({ success: true, users, total });
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

// GET /admin/transactions
exports.listTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;

    const transactions = await WalletTransaction.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await WalletTransaction.countDocuments(filter);
    res.json({ success: true, transactions, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/deposits/:id/approve
exports.approveDeposit = async (req, res) => {
  try {
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    if (deposit.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });

    deposit.status = 'confirmed';
    deposit.creditedAt = new Date();
    await deposit.save();

    await Wallet.findOneAndUpdate({ userId: deposit.userId }, { $inc: { balance: deposit.amount } });
    await WalletTransaction.findOneAndUpdate({ txHash: deposit.txHash }, { status: 'completed', completedAt: new Date() });

    res.json({ success: true, message: 'Deposit approved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/deposits
exports.listDeposits = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, chain } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (chain) filter.chain = chain;

    const deposits = await Deposit.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Deposit.countDocuments(filter);
    res.json({ success: true, deposits, total });
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

    deposit.status = 'rejected';
    if (reason) deposit.rejectionReason = reason;
    await deposit.save();

    await WalletTransaction.findOneAndUpdate({ txHash: deposit.txHash }, { status: 'rejected' });
    res.json({ success: true, message: 'Deposit rejected' });
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

    const withdrawals = await Withdrawal.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Withdrawal.countDocuments(filter);
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
    if (withdrawal.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });

    withdrawal.status = 'approved';
    withdrawal.approvedBy = req.admin._id;
    await withdrawal.save();

    res.json({ success: true, message: 'Withdrawal approved' });
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

    withdrawal.status = 'rejected';
    withdrawal.rejectionReason = reason;
    await withdrawal.save();

    // Refund locked funds
    await Wallet.findOneAndUpdate({ userId: withdrawal.userId }, { $inc: { balance: withdrawal.amount, locked: -withdrawal.amount } });

    res.json({ success: true, message: 'Withdrawal rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/commission-settings
exports.getCommissionSettings = async (req, res) => {
  try {
    const settings = await CommissionSetting.find();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/commission-settings
exports.updateCommissionSettings = async (req, res) => {
  try {
    const { settings } = req.body; // [{ type, rateType, rate }]
    for (const s of settings) {
      await CommissionSetting.findOneAndUpdate({ type: s.type }, { rateType: s.rateType, rate: s.rate }, { upsert: true });
    }
    res.json({ success: true, message: 'Commission settings updated' });
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
    const { page = 1, limit = 20, type } = req.query;
    const filter = {};
    if (type) filter.type = type;

    const records = await CommissionLedger.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await CommissionLedger.countDocuments(filter);
    res.json({ success: true, records, total });
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
