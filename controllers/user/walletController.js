const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const WalletAddress = require('../../models/WalletAddress');
const ImportedWallet = require('../../models/ImportedWallet');
const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
const { resolveCommission } = require('../../lib/commissionResolver');
const cryptrum = require('../../services/CryptrumService');

// GET /user/wallet
exports.getWallet = async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
    res.json({ success: true, wallet });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /user/wallet/payment-methods?type=deposit|withdraw
// Pulls live network list from Cryptrum and returns it as-is to the UI.
exports.getPaymentMethods = async (req, res) => {
  try {
    const type = req.query.type === 'withdraw' ? 'withdraw' : 'deposit';
    const { items, imageBaseUrl } = await cryptrum.getPaymentMethods(type);
    res.json({ success: true, type, methods: items, imageBaseUrl });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to load payment methods' });
  }
};

// GET /user/wallet/cryptrum/deposits?paymentMethodId=&fromDate=&toDate=&page=
exports.cryptrumDeposits = async (req, res) => {
  try {
    const paymentMethodId = Number(req.query.paymentMethodId);
    if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ success: false, message: 'paymentMethodId is required' });
    }
    const data = await cryptrum.getDepositList({
      uniqueId:        req.user._id.toString(),
      paymentMethodId,
      fromDate:        req.query.fromDate,
      toDate:          req.query.toDate,
      page:            req.query.page,
      depositStatus:   req.query.depositStatus,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to load deposits' });
  }
};

// POST /user/wallet/deposit/check  body: { paymentMethodId }
//
// Reconciles confirmed deposits from Cryptrum into this user's wallet.
// Race-safe by design:
//   1. Each Cryptrum `thash` insert into `deposits` is guarded by the unique
//      partial index `uniq_chain_txhash` on (chain, txHash). A duplicate
//      insert fails with E11000 — the wallet credit never runs.
//   2. The Deposit insert, Wallet $inc, WalletTransaction insert, and
//      CommissionLedger insert all run inside one Mongo transaction
//      (`session.withTransaction`). If any step fails, the entire
//      credit is rolled back atomically.
//   3. Re-poll, double-click, parallel tab, parallel admin trigger — only
//      one transaction can ever commit per Cryptrum thash. The rest see
//      "already credited" and silently skip.
exports.checkDeposits = async (req, res) => {
  try {
    const paymentMethodId = Number(req.body.paymentMethodId);
    if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ success: false, message: 'paymentMethodId is required' });
    }

    const User = require('../../models/User');
    const user = await User.findById(req.user._id).select('cryptoAddresses');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const cached = (user.cryptoAddresses || []).find(a => a.paymentMethodId === paymentMethodId);
    if (!cached) {
      return res.status(400).json({ success: false, message: 'No deposit address issued for this network yet' });
    }

    // Pull latest deposits from Cryptrum (balance_sync=1 forces Cryptrum to
    // refresh chain balances before responding).
    const cryptrumData = await cryptrum.getDepositList({
      uniqueId:        req.user._id.toString(),
      paymentMethodId,
      balanceSync:     1,
    });

    const credited = [];
    const skipped  = [];

    for (const dep of (cryptrumData.deposits || [])) {
      // Only credit confirmed deposits — Cryptrum returns status=0 for in-flight.
      if (dep.status !== 1) { skipped.push({ txHash: dep.txHash, reason: 'unconfirmed' }); continue; }
      if (!dep.txHash)      { skipped.push({ txHash: null,        reason: 'missing-txhash' }); continue; }

      const chain = String(dep.networkName || cached.networkName || '').toUpperCase();
      const gross = Number(dep.usdtAmount); // USD value Cryptrum already settled
      if (!Number.isFinite(gross) || gross <= 0) {
        skipped.push({ txHash: dep.txHash, reason: 'bad-amount' });
        continue;
      }

      // Commission resolution is read-only against settings collections and
      // safe to do outside the transaction — values are captured at start.
      const commSetting = await resolveCommission(req.user._id, 'deposit');
      let fee = 0;
      if (commSetting) {
        fee = commSetting.rateType === 'percentage'
          ? Math.round(gross * commSetting.rate / 100 * 100) / 100
          : commSetting.rate;
      }
      const netCredit = Math.max(0, Math.round((gross - fee) * 100) / 100);
      const txId      = 'CR-' + crypto.randomBytes(8).toString('hex').toUpperCase();

      const session = await mongoose.startSession();
      try {
        let committed = false;
        await session.withTransaction(async () => {
          // (1) Deposit row — unique (chain, txHash) is the dedupe primitive.
          // If a parallel request already inserted this thash, this throws
          // E11000 and the whole transaction aborts before any wallet mutation.
          await Deposit.create([{
            userId:          req.user._id,
            chain,
            asset:           dep.name || cached.name || 'USDT',
            amount:          netCredit,
            txHash:          dep.txHash,
            transactionId:   txId,
            toAddress:       cached.address,
            source:          'auto',
            confirmations:   99,
            requiredConfs:   0,
            verifiedOnChain: true,
            status:          'confirmed',
            creditedAt:      new Date(),
            notes:           `Cryptrum auto-credit (gross $${gross.toFixed(2)}, fee $${fee.toFixed(2)})`,
          }], { session });

          // (2) Credit wallet. Upsert is safe — if the wallet doc somehow
          // doesn't exist yet (new user), this creates it with the credit.
          const wallet = await Wallet.findOneAndUpdate(
            { userId: req.user._id },
            { $inc: { balance: netCredit }, $setOnInsert: { userId: req.user._id, locked: 0 } },
            { session, new: true, upsert: true },
          );

          // (3) Audit row for wallet history.
          await WalletTransaction.create([{
            userId:        req.user._id,
            walletId:      wallet._id,
            type:          'deposit',
            amount:        netCredit,
            status:        'completed',
            transactionId: txId,
            chain,
            txHash:        dep.txHash,
            notes:         `Cryptrum ${chain} deposit`,
            completedAt:   new Date(),
          }], { session });

          // (4) Commission ledger entry if a fee applied.
          if (commSetting && fee > 0) {
            await CommissionLedger.create([{
              userId:           req.user._id,
              transactionId:    txId,
              type:             'deposit',
              grossAmount:      gross,
              commissionAmount: fee,
              netAmount:        netCredit,
              rateType:         commSetting.rateType,
              rate:             commSetting.rate,
            }], { session });
          }

          committed = true;
        });

        if (committed) {
          credited.push({ txHash: dep.txHash, gross, fee, netCredit, chain, name: dep.name });
        }
      } catch (e) {
        if (e && e.code === 11000) {
          // Already credited by a prior call / parallel request — totally fine.
          skipped.push({ txHash: dep.txHash, reason: 'already-credited' });
        } else {
          console.error('[Cryptrum checkDeposits tx failed]', dep.txHash, e.message);
          skipped.push({ txHash: dep.txHash, reason: 'tx-failed', error: e.message });
        }
      } finally {
        session.endSession();
      }
    }

    // Pull the resulting balance so the UI can refresh without a second call.
    const w = await Wallet.findOne({ userId: req.user._id }).select('balance locked');

    res.json({
      success: true,
      credited,
      skipped,
      newBalance: w?.balance ?? null,
      address:    cryptrumData.address || cached.address,
      cryptrumTotals: {
        totalDepositAmount: cryptrumData.totalDepositAmount,
        verifiedDeposit:    cryptrumData.verifiedDeposit,
        totalDeposit:       cryptrumData.totalDeposit,
      },
    });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to check deposits' });
  }
};

// GET /user/wallet/cryptrum/withdrawals — filtered to this user via reference_id
// (we use Mongo Withdrawal._id as reference_id when pushing to Cryptrum).
exports.cryptrumWithdrawals = async (req, res) => {
  try {
    // Fetch this user's withdrawal codes from local DB, then ask Cryptrum
    // for each. Avoids leaking other users' codes if Cryptrum doesn't scope
    // /withdraw-list per app caller — we filter on our side.
    const userWithdrawals = await Withdrawal.find({
      userId: req.user._id,
      cryptrumCode: { $ne: null },
    }).select('cryptrumCode');
    const codes = userWithdrawals.map(w => w.cryptrumCode);
    if (codes.length === 0) return res.json({ success: true, withdrawals: [], pagination: null });

    // Cryptrum's /withdraw-list supports filtering by `code` — fetch each code
    // individually (the list is small, normally just the user's own history).
    const results = await Promise.all(codes.map(code =>
      cryptrum.getWithdrawList({ code }).then(r => r.withdrawals[0]).catch(() => null)
    ));
    res.json({ success: true, withdrawals: results.filter(Boolean) });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to load withdrawals' });
  }
};

// POST /user/wallet/deposit/address
// Body: { paymentMethodId: number }  — Cryptrum payment_method_id
// Returns an existing cached address from user.cryptoAddresses, or fetches a
// fresh one from Cryptrum and persists it on the user.
exports.getDepositAddress = async (req, res) => {
  try {
    const paymentMethodId = Number(req.body.paymentMethodId);
    if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ success: false, message: 'paymentMethodId is required' });
    }

    const User = require('../../models/User');
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Re-use any cached row for this network
    const existing = (user.cryptoAddresses || []).find(a => a.paymentMethodId === paymentMethodId);
    if (existing && existing.address) {
      return res.json({
        success: true,
        address: existing.address,
        paymentMethodId,
        chain: existing.networkName,
        coinName: existing.name,
        cached: true,
      });
    }

    // Fetch the active method metadata so we can store name/network alongside the address
    const { items } = await cryptrum.getPaymentMethods('deposit');
    const method = items.find(m => m.id === paymentMethodId);
    if (!method) {
      return res.status(400).json({ success: false, message: 'Unknown or inactive payment method' });
    }
    if (!method.depositEnabled) {
      return res.status(400).json({ success: false, message: 'Deposits disabled on this network' });
    }

    const uniqueId = user._id.toString();
    const { address } = await cryptrum.fetchAddress(uniqueId, paymentMethodId);

    user.cryptoAddresses.push({
      paymentMethodId,
      address,
      name:        method.name,
      networkName: method.networkName,
      networkType: method.networkType,
      chainId:     method.chainId,
    });
    await user.save();

    res.json({
      success: true,
      address,
      paymentMethodId,
      chain: method.networkName,
      coinName: method.name,
      cached: false,
    });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to issue deposit address' });
  }
};

// POST /user/wallet/deposit/manual
const MAX_DEPOSIT_AMOUNT = 1_000_000; // hard upper bound; admin still verifies on-chain before approving
exports.submitManualDeposit = async (req, res) => {
  try {
    const { txHash, chain, coinKey } = req.body;
    if (typeof txHash !== 'string' || !txHash.trim()) return res.status(400).json({ success: false, message: 'txHash is required' });
    if (typeof chain !== 'string'  || !chain.trim())  return res.status(400).json({ success: false, message: 'chain is required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive finite number' });
    }
    if (amount > MAX_DEPOSIT_AMOUNT) {
      return res.status(400).json({ success: false, message: `amount exceeds maximum (${MAX_DEPOSIT_AMOUNT})` });
    }

    const paymentMethodId = Number(req.body.paymentMethodId);
    let toAddress = '';
    if (Number.isInteger(paymentMethodId) && paymentMethodId > 0) {
      const User = require('../../models/User');
      const u = await User.findById(req.user._id).select('cryptoAddresses');
      const hit = u?.cryptoAddresses?.find(a => a.paymentMethodId === paymentMethodId);
      if (hit) toAddress = hit.address;
    }
    if (!toAddress) {
      const legacy = await WalletAddress.findOne({ userId: req.user._id, coinKey });
      toAddress = legacy?.address || '';
    }
    const wallet = await Wallet.findOne({ userId: req.user._id });

    // Create the Deposit first. The unique (chain, txHash) index guarantees that
    // two concurrent submits (or a scanner re-poll) cannot both insert — the
    // second hits E11000 and we return the same "already submitted" response.
    try {
      await Deposit.create({ userId: req.user._id, chain, asset: 'USDT', amount, txHash, toAddress, status: 'pending' });
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(400).json({ success: false, message: 'Transaction already submitted' });
      }
      throw e;
    }

    // WalletTransaction is best-effort observability — created after Deposit so
    // a duplicate Deposit insert short-circuits before producing a stray txn row.
    const txId = crypto.randomBytes(16).toString('hex');
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

    res.json({ success: true, message: 'Deposit submitted for verification' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /user/wallet/deposit/static — TEST ONLY: instantly credits wallet without crypto.
// Body: { amount, chain?, note? }
exports.submitStaticDeposit = async (req, res) => {
  try {
    // Production safety: this endpoint can mint balance and must never run in production.
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const amount = Number(req.body.amount);
    const chain  = req.body.chain || 'TEST';
    const note   = req.body.note  || 'Static test deposit';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    let wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) wallet = await Wallet.create({ userId: req.user._id, balance: 0 });

    // Commission on deposit (3-tier resolver: user → merchant → global)
    const commSetting = await resolveCommission(req.user._id, 'deposit');

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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /user/wallet/deposit/status/:txHash
exports.depositStatus = async (req, res) => {
  try {
    const deposit = await Deposit.findOne({ txHash: req.params.txHash, userId: req.user._id });
    if (!deposit) return res.status(404).json({ success: false, message: 'Deposit not found' });
    res.json({ success: true, status: deposit.status, confirmations: deposit.confirmations, required: deposit.requiredConfs });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /user/wallet/withdraw
exports.initiateWithdraw = async (req, res) => {
  try {
    const { chain, amount, toAddress, coinKey } = req.body;
    const paymentMethodId = req.body.paymentMethodId != null ? Number(req.body.paymentMethodId) : null;
    if (!chain || !amount || !toAddress) return res.status(400).json({ success: false, message: 'chain, amount, toAddress required' });
    if (paymentMethodId != null && (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0)) {
      return res.status(400).json({ success: false, message: 'paymentMethodId must be a positive integer' });
    }

    if (req.user.kycStatus !== 'approved') return res.status(403).json({ success: false, message: 'KYC approval required' });

    // Commission calculation (read-only — does not mutate wallet)
    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'withdrawal' });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'withdrawal' });

    let fee = 0;
    if (commSetting) {
      fee = commSetting.rateType === 'percentage' ? (amount * commSetting.rate) / 100 : commSetting.rate;
    }
    const netAmount = amount - fee;

    // Atomic check-and-debit: in a single round-trip Mongo verifies the user
    // has the funds AND moves them from balance → locked. Two parallel
    // submits (double-click / network retry) cannot both pass the precondition,
    // so duplicate `pending` withdrawals for the same balance are impossible.
    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.user._id, balance: { $gte: amount } },
      { $inc: { balance: -amount, locked: amount } },
      { new: true },
    );
    if (!wallet) {
      // Either the wallet doesn't exist, or balance was insufficient — keep
      // the original 400 response shape for the UI's existing handling.
      const exists = await Wallet.exists({ userId: req.user._id });
      if (!exists) return res.status(404).json({ success: false, message: 'Wallet not found' });
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    let withdrawal;
    try {
      withdrawal = await Withdrawal.create({
        userId: req.user._id, chain, asset: 'USDT', amount, fee, toAddress, paymentMethodId, status: 'pending',
      });
    } catch (createErr) {
      // Withdrawal row failed to persist — release the funds we just locked
      // so the user isn't left with a phantom hold.
      await Wallet.findOneAndUpdate(
        { userId: req.user._id, locked: { $gte: amount } },
        { $inc: { balance: amount, locked: -amount } },
      );
      throw createErr;
    }

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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /user/wallet/withdrawal/status/:id
exports.withdrawalStatus = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, userId: req.user._id });
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    res.json({ success: true, status: withdrawal.status, txHash: withdrawal.txHash });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
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
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /user/wallet/import
exports.importWallet = async (req, res) => {
  try {
    const { label, encryptedMnemonic, encryptionIv, encryptionTag, evmAddress, tronAddress } = req.body;
    const imported = await ImportedWallet.create({ userId: req.user._id, label, encryptedMnemonic, encryptionIv, encryptionTag, evmAddress, tronAddress });
    res.status(201).json({ success: true, wallet: imported });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// DELETE /user/wallet/import/:id
exports.deleteImportedWallet = async (req, res) => {
  try {
    await ImportedWallet.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true, message: 'Imported wallet removed' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
