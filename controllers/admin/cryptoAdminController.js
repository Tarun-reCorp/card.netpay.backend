const Deposit       = require('../../models/Deposit');
const Withdrawal    = require('../../models/Withdrawal');
const ChainSetting  = require('../../models/ChainSetting');
const AdminWallet   = require('../../models/AdminWallet');
const HotWallet     = require('../../models/HotWallet');
const GasTreasury   = require('../../models/GasTreasury');
const GasLog        = require('../../models/GasLog');
const WalletServiceLog = require('../../models/WalletServiceLog');
const Wallet        = require('../../models/Wallet');

const CHAIN_META = {
  BEP20:     { name: 'BNB Smart Chain (BEP20)', native: 'BNB',  explorer: 'https://bscscan.com/tx/' },
  ERC20:     { name: 'Ethereum (ERC20)',         native: 'ETH',  explorer: 'https://etherscan.io/tx/' },
  POLYGON:   { name: 'Polygon',                  native: 'MATIC',explorer: 'https://polygonscan.com/tx/' },
  ARBITRUM:  { name: 'Arbitrum',                 native: 'ETH',  explorer: 'https://arbiscan.io/tx/' },
  BASE:      { name: 'Base',                     native: 'ETH',  explorer: 'https://basescan.org/tx/' },
  AVALANCHE: { name: 'Avalanche C-Chain',        native: 'AVAX', explorer: 'https://snowtrace.io/tx/' },
  OPTIMISM:  { name: 'Optimism',                 native: 'ETH',  explorer: 'https://optimistic.etherscan.io/tx/' },
  TRC20:     { name: 'Tron (TRC20)',             native: 'TRX',  explorer: 'https://tronscan.org/#/transaction/' },
};

// GET /admin/crypto/dashboard
exports.dashboard = async (req, res) => {
  try {
    const [
      chains, pendingDeposits, pendingWithdrawals, gasTreasury, hotWallets,
      totalDeposits, completedDeposits, totalWithdrawals, approvedWithdrawals,
    ] = await Promise.all([
      ChainSetting.find().sort({ chain: 1 }),
      Deposit.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      GasTreasury.find().sort({ chain: 1 }),
      HotWallet.find().sort({ derivationIndex: 1 }),
      Deposit.countDocuments(),
      Deposit.countDocuments({ status: 'completed' }),
      Withdrawal.countDocuments(),
      Withdrawal.countDocuments({ status: 'approved' }),
    ]);

    // Aggregate treasury by chain
    const chainBalances = {};
    gasTreasury.forEach(g => {
      if (!chainBalances[g.chain]) {
        chainBalances[g.chain] = { nativeBalance: 0, usdtBalance: 0, nativeCurrency: g.nativeCurrency };
      }
      chainBalances[g.chain].nativeBalance += g.nativeBalance;
      chainBalances[g.chain].usdtBalance   += g.usdtBalance;
    });

    // Enrich chains with meta
    const enrichedChains = chains.map(c => ({
      ...c.toObject(),
      meta: CHAIN_META[c.chain] || {},
    }));

    res.json({
      success: true,
      chains: enrichedChains,
      pendingDeposits,
      pendingWithdrawals,
      gasTreasury,
      chainBalances,
      hotWallets,
      stats: {
        totalDeposits, completedDeposits, pendingDeposits,
        totalWithdrawals, approvedWithdrawals, pendingWithdrawals,
        activeChains: chains.filter(c => c.enabled).length,
        hotWalletCount: hotWallets.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/chains/:chain/toggle
exports.toggleChain = async (req, res) => {
  try {
    const { field = 'enabled' } = req.body;
    if (!['enabled', 'depositEnabled', 'withdrawEnabled'].includes(field))
      return res.status(400).json({ success: false, message: 'Invalid field' });

    const chain = await ChainSetting.findOne({ chain: req.params.chain });
    if (!chain) return res.status(404).json({ success: false, message: 'Chain not found' });

    chain[field] = !chain[field];
    await chain.save();
    res.json({ success: true, chain });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/hot-wallets
exports.listHotWallets = async (req, res) => {
  try {
    const wallets = await HotWallet.find().sort({ derivationIndex: 1 });
    res.json({ success: true, wallets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /admin/crypto/hot-wallets/:id/toggle
exports.toggleHotWallet = async (req, res) => {
  try {
    const wallet = await HotWallet.findById(req.params.id);
    if (!wallet) return res.status(404).json({ success: false, message: 'Hot wallet not found' });
    wallet.enabled = !wallet.enabled;
    await wallet.save();
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /admin/crypto/admin-wallets
exports.listAdminWallets = async (req, res) => {
  try {
    const wallets = await AdminWallet.find()
      .select('-encryptedPrivateKey -encryptionIv -encryptionTag')
      .sort({ createdAt: -1 });
    res.json({ success: true, wallets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /admin/crypto/admin-wallets
exports.createAdminWallet = async (req, res) => {
  try {
    const { label, evmAddress, tronAddress, walletType, notes } = req.body;
    if (!label)      return res.status(422).json({ success: false, message: 'Label is required' });
    if (!evmAddress) return res.status(422).json({ success: false, message: 'EVM address is required' });

    // Check duplicate
    const exists = await AdminWallet.findOne({ evmAddress });
    if (exists) return res.status(422).json({ success: false, message: 'EVM address already registered' });

    const wallet = await AdminWallet.create({
      label, evmAddress, tronAddress: tronAddress || null,
      walletType: walletType || 'hot',
      notes: notes || null,
      encryptedPrivateKey: 'managed-externally',
      encryptionIv: 'n/a',
      encryptionTag: 'n/a',
    });
    res.status(201).json({
      success: true,
      wallet: { id: wallet._id, label: wallet.label, evmAddress: wallet.evmAddress },
    });
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
    const wallet = await AdminWallet.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select('-encryptedPrivateKey -encryptionIv -encryptionTag');
    if (!wallet) return res.status(404).json({ success: false, message: 'Not found' });
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
    if (chain)  filter.chain = chain;

    const [deposits, total] = await Promise.all([
      Deposit.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      Deposit.countDocuments(filter),
    ]);
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
    if (chain)  filter.chain = chain;

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter)
        .populate('userId', 'name email')
        .populate('hotWalletId', 'evmAddress tronAddress label')
        .sort({ createdAt: -1 })
        .skip((page - 1) * Number(limit))
        .limit(Number(limit)),
      Withdrawal.countDocuments(filter),
    ]);
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
    if (withdrawal.status !== 'pending')
      return res.status(400).json({ success: false, message: `Cannot approve — status is ${withdrawal.status}` });

    withdrawal.status = 'approved';
    withdrawal.approvedBy = req.admin._id;
    await withdrawal.save();
    res.json({ success: true, message: 'Withdrawal approved — will be processed by wallet service' });
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
    if (!['pending', 'approved'].includes(withdrawal.status))
      return res.status(400).json({ success: false, message: `Cannot reject — status is ${withdrawal.status}` });

    withdrawal.status = 'rejected';
    withdrawal.rejectionReason = reason || 'Rejected by admin';
    await withdrawal.save();

    // Refund locked funds back to wallet balance
    await Wallet.findOneAndUpdate(
      { userId: withdrawal.userId },
      { $inc: { balance: withdrawal.amount, locked: -withdrawal.amount } },
    );
    res.json({ success: true, message: 'Withdrawal rejected and funds refunded to user wallet' });
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

    const [logs, total] = await Promise.all([
      GasLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * Number(limit)).limit(Number(limit)),
      GasLog.countDocuments(filter),
    ]);
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
    if (level)    filter.level    = level;
    if (chain)    filter.chain    = chain;

    const [logs, total] = await Promise.all([
      WalletServiceLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * Number(limit)).limit(Number(limit)),
      WalletServiceLog.countDocuments(filter),
    ]);
    res.json({ success: true, logs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
