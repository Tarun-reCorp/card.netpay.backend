const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const ChainSetting = require('../../models/ChainSetting');
const AdminWallet = require('../../models/AdminWallet');
const HotWallet = require('../../models/HotWallet');
const GasTreasury = require('../../models/GasTreasury');
const GasLog = require('../../models/GasLog');
const WalletServiceLog = require('../../models/WalletServiceLog');
const Wallet = require('../../models/Wallet');

// GET /admin/crypto/dashboard
exports.dashboard = async (req, res) => {
  try {
    const [chains, deposits, withdrawals, gasTreasury] = await Promise.all([
      ChainSetting.find(),
      Deposit.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      GasTreasury.find(),
    ]);
    res.json({ success: true, chains, pendingDeposits: deposits, pendingWithdrawals: withdrawals, gasTreasury });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/chains/:chain/toggle
exports.toggleChain = async (req, res) => {
  try {
    const { field = 'enabled' } = req.body; // enabled | depositEnabled | withdrawEnabled
    const chain = await ChainSetting.findOne({ chain: req.params.chain });
    if (!chain) return res.status(404).json({ success: false, message: 'Chain not found' });

    chain[field] = !chain[field];
    await chain.save();
    res.json({ success: true, chain });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/admin-wallets
exports.listAdminWallets = async (req, res) => {
  try {
    const wallets = await AdminWallet.find().select('-encryptedPrivateKey -encryptionIv -encryptionTag');
    res.json({ success: true, wallets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/crypto/admin-wallets
exports.createAdminWallet = async (req, res) => {
  try {
    const wallet = await AdminWallet.create(req.body);
    res.status(201).json({ success: true, wallet: { id: wallet._id, label: wallet.label, evmAddress: wallet.evmAddress } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/admin-wallets/:id
exports.updateAdminWallet = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates.encryptedPrivateKey;
    delete updates.encryptionIv;
    delete updates.encryptionTag;
    const wallet = await AdminWallet.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-encryptedPrivateKey -encryptionIv -encryptionTag');
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /admin/crypto/admin-wallets/:id
exports.deleteAdminWallet = async (req, res) => {
  try {
    await AdminWallet.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Admin wallet deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/deposits
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

// GET /admin/crypto/withdrawals
exports.listWithdrawals = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, chain } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (chain) filter.chain = chain;

    const withdrawals = await Withdrawal.find(filter)
      .populate('userId', 'name email')
      .populate('hotWalletId', 'evmAddress tronAddress')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Withdrawal.countDocuments(filter);
    res.json({ success: true, withdrawals, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/withdrawals/:id/approve
exports.approveWithdrawal = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ success: false, message: 'Already processed' });

    withdrawal.status = 'approved';
    withdrawal.approvedBy = req.admin._id;
    await withdrawal.save();
    res.json({ success: true, message: 'Withdrawal approved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/withdrawals/:id/reject
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Not found' });

    withdrawal.status = 'rejected';
    withdrawal.rejectionReason = reason;
    await withdrawal.save();

    await Wallet.findOneAndUpdate({ userId: withdrawal.userId }, { $inc: { balance: withdrawal.amount, locked: -withdrawal.amount } });
    res.json({ success: true, message: 'Withdrawal rejected and funds refunded' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/gas-treasury
exports.gasTreasury = async (req, res) => {
  try {
    const treasury = await GasTreasury.find().sort({ chain: 1 });
    res.json({ success: true, treasury });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/gas-logs
exports.gasLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, chain } = req.query;
    const filter = {};
    if (chain) filter.chain = chain;

    const logs = await GasLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit));
    const total = await GasLog.countDocuments(filter);
    res.json({ success: true, logs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/service-logs
exports.walletServiceLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, category, level, chain } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (level) filter.level = level;
    if (chain) filter.chain = chain;

    const logs = await WalletServiceLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit));
    const total = await WalletServiceLog.countDocuments(filter);
    res.json({ success: true, logs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
