const Deposit       = require('../../models/Deposit');
const Withdrawal    = require('../../models/Withdrawal');
const ChainSetting  = require('../../models/ChainSetting');
const AdminWallet   = require('../../models/AdminWallet');
const HotWallet     = require('../../models/HotWallet');
const GasTreasury   = require('../../models/GasTreasury');
const GasLog        = require('../../models/GasLog');
const WalletServiceLog = require('../../models/WalletServiceLog');
const Wallet        = require('../../models/Wallet');
const { WITHDRAWAL_STATUS } = require('../../config/statuses');

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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/crypto/hot-wallets
exports.listHotWallets = async (req, res) => {
  try {
    const wallets = await HotWallet.find().sort({ derivationIndex: 1 });
    res.json({ success: true, wallets });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// DELETE /admin/crypto/admin-wallets/:id
exports.deleteAdminWallet = async (req, res) => {
  try {
    await AdminWallet.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Admin wallet deleted' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/crypto/withdrawals/:id/approve
exports.approveWithdrawal = async (req, res) => {
  try {
    // Atomic pending → approved. Mirrors adminController.approveWithdrawal so
    // both routes are safe under concurrent admin clicks across either UI.
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: WITHDRAWAL_STATUS.PENDING },
      { $set: { status: WITHDRAWAL_STATUS.APPROVED, approvedBy: req.admin._id } },
      { new: true },
    );
    if (!withdrawal) {
      const exists = await Withdrawal.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ success: false, message: 'Not found' });
      return res.status(409).json({ success: false, message: 'Withdrawal already actioned' });
    }
    res.json({ success: true, message: 'Withdrawal approved — will be processed by wallet service' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// PUT /admin/crypto/withdrawals/:id/reject
// Restricted to PENDING state only — once a withdrawal is approved, funds may
// already be moving on-chain and refunding the wallet here would double-pay
// the user. Approved/processing rows must be reconciled via a separate
// reversal flow, never via this endpoint.
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;

    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: WITHDRAWAL_STATUS.PENDING },
      {
        $set: {
          status: WITHDRAWAL_STATUS.REJECTED,
          rejectionReason: reason || 'Rejected by admin',
        },
      },
      { new: true },
    );
    if (!withdrawal) {
      const exists = await Withdrawal.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ success: false, message: 'Not found' });
      return res.status(409).json({ success: false, message: 'Only pending withdrawals can be rejected' });
    }

    // Refund locked funds back to wallet balance. Lock decrement is guarded
    // by Math.min so it can never push `locked` negative for partial-lock rows.
    const wallet = await Wallet.findOne({ userId: withdrawal.userId });
    if (wallet) {
      const lockedDec = Math.min(wallet.locked, withdrawal.amount);
      await Wallet.findOneAndUpdate(
        { userId: withdrawal.userId },
        { $inc: { balance: withdrawal.amount, locked: -lockedDec } },
      );
    }

    res.json({ success: true, message: 'Withdrawal rejected and funds refunded to user wallet' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/crypto/gas-treasury
exports.gasTreasury = async (req, res) => {
  try {
    const treasury = await GasTreasury.find().sort({ chain: 1 });
    res.json({ success: true, treasury });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
