const crypto = require('crypto');
const axios = require('axios');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const WalletAddress = require('../../models/WalletAddress');
const ImportedWallet = require('../../models/ImportedWallet');
const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
const ChainSetting = require('../../models/ChainSetting');

const SUPPORTED_COINS = [
  { coinKey: 'USDT_TRC20',  chain: 'TRC20',    coinName: 'USDT' },
  { coinKey: 'USDT_BEP20',  chain: 'BEP20',    coinName: 'USDT' },
  { coinKey: 'USDT_ERC20',  chain: 'ERC20',    coinName: 'USDT' },
  { coinKey: 'USDT_POLYGON',chain: 'POLYGON',  coinName: 'USDT' },
  { coinKey: 'USDT_ARB',    chain: 'ARBITRUM', coinName: 'USDT' },
  { coinKey: 'USDT_BASE',   chain: 'BASE',     coinName: 'USDT' },
  { coinKey: 'USDT_AVAX',   chain: 'AVALANCHE',coinName: 'USDT' },
  { coinKey: 'USDT_OP',     chain: 'OPTIMISM', coinName: 'USDT' },
];

// GET /user/wallet
exports.getWallet = async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/wallet/deposit/supported-coins
exports.getSupportedCoins = async (req, res) => {
  try {
    const enabledChains = await ChainSetting.find({ enabled: true, depositEnabled: true }).select('chain');
    if (enabledChains.length === 0) {
      // No chain settings configured — return all supported coins as fallback
      return res.json({ success: true, coins: SUPPORTED_COINS });
    }
    const enabledChainNames = enabledChains.map(c => c.chain);
    const coins = SUPPORTED_COINS.filter(c => enabledChainNames.includes(c.chain));
    res.json({ success: true, coins });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/wallet/deposit/address
exports.getDepositAddress = async (req, res) => {
  try {
    const { coinKey } = req.body;
    const coin = SUPPORTED_COINS.find(c => c.coinKey === coinKey);
    if (!coin) return res.status(400).json({ success: false, message: 'Unsupported coin' });

    let walletAddress = await WalletAddress.findOne({ userId: req.user._id, coinKey });
    if (!walletAddress) {
      // In real usage, derive address from wallet-service; here we store as placeholder
      return res.status(400).json({ success: false, message: 'No deposit address found. Please contact support.' });
    }
    res.json({ success: true, address: walletAddress.address, chain: walletAddress.chain, coinName: walletAddress.coinName });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/wallet/deposit/manual
exports.submitManualDeposit = async (req, res) => {
  try {
    const { txHash, chain, coinKey, amount } = req.body;
    if (!txHash || !chain || !amount) return res.status(400).json({ success: false, message: 'txHash, chain and amount required' });

    const existing = await Deposit.findOne({ txHash });
    if (existing) return res.status(400).json({ success: false, message: 'Transaction already submitted' });

    const walletAddress = await WalletAddress.findOne({ userId: req.user._id, coinKey });
    const toAddress = walletAddress?.address || '';

    const txId = crypto.randomBytes(16).toString('hex');
    const wallet = await Wallet.findOne({ userId: req.user._id });

    await WalletTransaction.create({
      userId: req.user._id,
      walletId: wallet._id,
      type: 'deposit',
      amount,
      status: 'pending',
      transactionId: txId,
      coinKey,
      chain,
      txHash,
      depositAddress: toAddress,
    });

    await Deposit.create({ userId: req.user._id, chain, asset: 'USDT', amount, txHash, toAddress, status: 'pending' });

    res.json({ success: true, message: 'Deposit submitted for verification' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/wallet/deposit/static — TEST ONLY: instantly credits wallet without crypto.
// Body: { amount, chain?, note? }
exports.submitStaticDeposit = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const chain  = req.body.chain || 'TEST';
    const note   = req.body.note  || 'Static test deposit';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    let wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) wallet = await Wallet.create({ userId: req.user._id, balance: 0 });

    // Commission on deposit (optional — uses 'deposit' commission setting if defined)
    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'deposit' });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'deposit' });

    let fee = 0;
    if (commSetting) {
      fee = commSetting.rateType === 'percentage'
        ? Math.round(amount * commSetting.rate / 100 * 100) / 100
        : commSetting.rate;
    }
    const netCredit = Math.max(0, Math.round((amount - fee) * 100) / 100);

    const txId = 'TEST-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const txHash = 'TEST-' + crypto.randomBytes(16).toString('hex');

    // Create Deposit FIRST so validation (chain enum, etc.) fails before any wallet mutation.
    const deposit = await Deposit.create({
      userId         : req.user._id,
      chain,
      asset          : 'USDT',
      amount         : netCredit,
      txHash,
      toAddress      : 'STATIC-TEST',
      source         : 'manual',
      status         : 'confirmed',
      confirmations  : 99,
      requiredConfs  : 0,
      verifiedOnChain: false,
      creditedAt     : new Date(),
      notes          : note,
    });

    wallet.balance = Math.round((wallet.balance + netCredit) * 100) / 100;
    await wallet.save();

    await WalletTransaction.create({
      userId        : req.user._id,
      walletId      : wallet._id,
      type          : 'deposit',
      amount        : netCredit,
      status        : 'completed',
      transactionId : txId,
      chain,
      txHash,
      notes         : note,
      completedAt   : new Date(),
    });

    if (commSetting && fee > 0) {
      await CommissionLedger.create({
        userId          : req.user._id,
        transactionId   : txId,
        type            : 'deposit',
        grossAmount     : amount,
        commissionAmount: fee,
        netAmount       : netCredit,
        rateType        : commSetting.rateType,
        rate            : commSetting.rate,
      });
    }

    res.json({
      success     : true,
      message     : `$${netCredit.toFixed(2)} credited (test deposit).`,
      depositId   : deposit._id,
      newBalance  : wallet.balance,
      grossAmount : amount,
      fee,
      netCredit,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/wallet/deposit/status/:txHash
exports.depositStatus = async (req, res) => {
  try {
    const deposit = await Deposit.findOne({ txHash: req.params.txHash, userId: req.user._id });
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    res.json({ success: true, status: deposit.status, confirmations: deposit.confirmations, required: deposit.requiredConfs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/wallet/deposits
exports.listDeposits = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const deposits = await Deposit.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Deposit.countDocuments({ userId: req.user._id });
    res.json({ success: true, deposits, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/wallet/withdraw
exports.initiateWithdraw = async (req, res) => {
  try {
    const { chain, amount, toAddress, coinKey } = req.body;
    if (!chain || !amount || !toAddress) return res.status(400).json({ success: false, message: 'chain, amount, toAddress required' });

    if (req.user.kycStatus !== 'approved') return res.status(403).json({ success: false, message: 'KYC approval required' });

    const wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    // Commission calculation
    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'withdrawal' });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'withdrawal' });

    let fee = 0;
    if (commSetting) {
      fee = commSetting.rateType === 'percentage' ? (amount * commSetting.rate) / 100 : commSetting.rate;
    }
    const netAmount = amount - fee;

    if (wallet.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const withdrawal = await Withdrawal.create({ userId: req.user._id, chain, asset: 'USDT', amount, fee, toAddress, status: 'pending' });

    // Deduct from wallet and lock
    wallet.balance -= amount;
    wallet.locked += amount;
    await wallet.save();

    const txId = crypto.randomBytes(16).toString('hex');
    await WalletTransaction.create({
      userId: req.user._id,
      walletId: wallet._id,
      type: 'withdraw',
      amount,
      status: 'pending',
      transactionId: txId,
      referenceId: withdrawal._id.toString(),
      chain,
    });

    if (commSetting && fee > 0) {
      await CommissionLedger.create({
        userId: req.user._id,
        transactionId: txId,
        type: 'withdrawal',
        grossAmount: amount,
        commissionAmount: fee,
        netAmount,
        rateType: commSetting.rateType,
        rate: commSetting.rate,
      });
    }

    res.json({ success: true, message: 'Withdrawal request submitted', withdrawalId: withdrawal._id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/wallet/withdrawal/status/:id
exports.withdrawalStatus = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, userId: req.user._id });
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    res.json({ success: true, status: withdrawal.status, txHash: withdrawal.txHash });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/wallet/history
exports.history = async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    const filter = { userId: req.user._id };
    if (type) filter.type = type;
    if (status) filter.status = status;

    const transactions = await WalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await WalletTransaction.countDocuments(filter);
    res.json({ success: true, transactions, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/wallet/import
exports.importWallet = async (req, res) => {
  try {
    const { label, encryptedMnemonic, encryptionIv, encryptionTag, evmAddress, tronAddress } = req.body;
    const imported = await ImportedWallet.create({ userId: req.user._id, label, encryptedMnemonic, encryptionIv, encryptionTag, evmAddress, tronAddress });
    res.status(201).json({ success: true, wallet: imported });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /user/wallet/import/:id
exports.deleteImportedWallet = async (req, res) => {
  try {
    await ImportedWallet.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true, message: 'Imported wallet removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
