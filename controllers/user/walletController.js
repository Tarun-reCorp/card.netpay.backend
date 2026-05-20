const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const WalletAddress = require('../../models/WalletAddress');
const ImportedWallet = require('../../models/ImportedWallet');
const Deposit = require('../../models/Deposit');
const Withdrawal = require('../../models/Withdrawal');
const CommissionLedger = require('../../models/CommissionLedger');
const { resolveCommission } = require('../../lib/commissionResolver');
const { validateAmount, validateAddress, familyForMethod } = require('../../lib/cryptoValidation');
const {
  verifyDepositOwnership,
  computeCommission,
  selectAddressesToCheck,
} = require('../../lib/cryptoFlow');
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

// GET /user/wallet/cryptrum/deposits/all
//
// Aggregated deposit-list across every payment method the user has cached.
// Surfaces non-credit-able phases (pending / queued / failed / etc.) which
// `/deposit/check` discards via the `skipped[]` array and never persists.
// This is the data source for the "Pending & failed" panel on the Deposit
// page. Single per-method failures don't fail the request — Promise.allSettled
// keeps partial results so one chain being down still shows the others.
exports.cryptrumDepositsAll = async (req, res) => {
  try {
    const User = require('../../models/User');
    const user = await User.findById(req.user._id).select('cryptoAddresses');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const targets = (user.cryptoAddresses || []).filter(a => a.paymentMethodId && a.address);
    if (targets.length === 0) return res.json({ success: true, deposits: [] });

    const uniqueId = req.user._id.toString();
    const results = await Promise.allSettled(
      targets.map(t => cryptrum.getDepositList({
        uniqueId,
        paymentMethodId: t.paymentMethodId,
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
            paymentMethodId: targets[i].paymentMethodId,
            chain:           targets[i].networkName,
            asset:           targets[i].name,
          });
        }
      } else if (r.status === 'rejected') {
        console.warn('[cryptrumDepositsAll] method', targets[i].paymentMethodId, 'failed:', r.reason?.message);
      }
    }

    flat.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ success: true, deposits: flat });
  } catch (err) {
    console.error('[cryptrumDepositsAll]', err.message);
    res.status(500).json({ success: false, message: 'Failed to load deposit list' });
  }
};

// POST /user/wallet/deposit/check  body: { paymentMethodId? }
//
// Reconciles confirmed deposits from Cryptrum into this user's wallet.
//
//   • If `paymentMethodId` is given, only that network is checked.
//   • If omitted, EVERY cached address on the user is checked.
//     Useful when the user pays on a different EVM chain than they
//     generated the address on (BEP20 / POLYGON / ERC20 share addresses).
//
// Race-safety primitives (per credit):
//   1. Unique partial index on `Deposit.txHash` is the dedup primitive —
//      a duplicate insert fails with E11000 and the wallet credit never runs.
//   2. The Deposit insert, Wallet $inc, WalletTransaction insert, and
//      CommissionLedger insert all run inside one `session.withTransaction`.
//      Any step failing rolls the whole credit back atomically.
//   3. Parallel polls all converge — only one tx commits per txHash, the
//      rest see `already-credited` in their `skipped[]` and silently move on.
exports.checkDeposits = async (req, res) => {
  try {
    // ── (1) Validate & resolve target networks ────────────────────────
    const paymentMethodId = req.body.paymentMethodId == null
      ? null
      : Number(req.body.paymentMethodId);
    if (paymentMethodId != null && (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0)) {
      return res.status(400).json({ success: false, message: 'paymentMethodId must be a positive integer' });
    }

    const User = require('../../models/User');
    const user = await User.findById(req.user._id).select('cryptoAddresses');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const targets = selectAddressesToCheck(user.cryptoAddresses, paymentMethodId);
    if (targets.length === 0) {
      return res.status(400).json({
        success: false,
        message: paymentMethodId == null
          ? 'No deposit addresses issued yet — generate one before checking'
          : 'No deposit address issued for this network yet',
      });
    }

    // ── (2) Reconcile each network in series ──────────────────────────
    const credited        = [];
    const skipped         = [];
    const networksChecked = [];
    const userIdStr       = req.user._id.toString();

    for (const cached of targets) {
      let cryptrumData;
      try {
        cryptrumData = await cryptrum.getDepositList({
          uniqueId:        userIdStr,
          paymentMethodId: cached.paymentMethodId,
          balanceSync:     1,
        });
      } catch (e) {
        // One network's Cryptrum error must not abort the rest.
        console.error('[checkDeposits] cryptrum getDepositList failed:', cached.paymentMethodId, e.message);
        networksChecked.push({ paymentMethodId: cached.paymentMethodId, error: e.message });
        continue;
      }

      networksChecked.push({
        paymentMethodId: cached.paymentMethodId,
        chain:           cached.networkName,
        depositCount:    cryptrumData.deposits?.length || 0,
      });

      for (const dep of (cryptrumData.deposits || [])) {
        const outcome = await reconcileOneDeposit(req.user._id, userIdStr, dep, cached);
        if (outcome.credited) credited.push(outcome.credited);
        else                  skipped.push(outcome.skipped);
      }
    }

    // ── (3) Final wallet snapshot for the UI ──────────────────────────
    const w = await Wallet.findOne({ userId: req.user._id }).select('balance locked');

    res.json({
      success: true,
      credited,
      skipped,
      newBalance: w?.balance ?? null,
      networksChecked,
    });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to check deposits' });
  }
};

// Reconcile a single Cryptrum deposit row into the local wallet. Used by
// `checkDeposits` once per (network × Cryptrum row). Returns either
//   { credited: {...} }  — wallet was incremented
// or
//   { skipped:  { txHash, reason, ... } } — see reason codes below.
//
// Reason codes:
//   unconfirmed / pending / queued-for-verification / failed
//                                                — see CRYPTRUM_DEPOSIT_STATUS
//   missing-txhash    — Cryptrum returned a confirmed row with no txHash
//   wrong-user        — uniqueId from Cryptrum did not match this user
//   address-mismatch  — toAddress did not match the cached address
//   bad-amount        — usdtAmount was not a positive finite number
//   already-credited  — unique index hit; another caller credited it first
//   tx-failed         — Mongo transaction errored
async function reconcileOneDeposit(userId, userIdStr, dep, cached) {
  // (a) Phase filter — only Cryptrum phase 1 (completed) is credit-able.
  if (!dep.confirmed) {
    return { skipped: { txHash: dep.txHash, reason: dep.statusCode || 'unconfirmed', label: dep.statusLabel } };
  }
  if (!dep.txHash) {
    return { skipped: { txHash: null, reason: 'missing-txhash' } };
  }

  // (b) Ownership filter — uniqueId echo + toAddress match.
  const own = verifyDepositOwnership(dep, userIdStr, cached);
  if (!own.ok) {
    return { skipped: { txHash: dep.txHash, reason: own.reason } };
  }

  // (c) Amount filter.
  const gross = Number(dep.usdtAmount);
  if (!Number.isFinite(gross) || gross <= 0) {
    return { skipped: { txHash: dep.txHash, reason: 'bad-amount' } };
  }

  // (d) Commission (read-only — values captured before the tx starts).
  const commSetting = await resolveCommission(userId, 'deposit');
  const { fee, net: netCredit } = computeCommission(commSetting, gross);

  const chain = String(dep.networkName || cached.networkName || '').toUpperCase();
  const txId  = 'CR-' + crypto.randomBytes(8).toString('hex').toUpperCase();

  // (e) Atomic credit — Deposit + Wallet + WalletTransaction + Commission.
  const session = await mongoose.startSession();
  try {
    let committed = false;
    await session.withTransaction(async () => {
      await Deposit.create([{
        userId,
        chain,
        asset:           dep.name || cached.name || 'USDT',
        amount:          netCredit,
        txHash:          dep.txHash,
        transactionId:   txId,
        toAddress:       dep.toAddress || cached.address,
        fromAddress:     dep.fromAddress || null,
        source:          'auto',
        confirmations:   99,
        requiredConfs:   0,
        verifiedOnChain: true,
        status:          'confirmed',
        creditedAt:      new Date(),
        notes:           `Cryptrum auto-credit (gross $${gross.toFixed(2)}, fee $${fee.toFixed(2)})`,
      }], { session });

      const wallet = await Wallet.findOneAndUpdate(
        { userId },
        { $inc: { balance: netCredit }, $setOnInsert: { userId, locked: 0 } },
        { session, new: true, upsert: true },
      );

      await WalletTransaction.create([{
        userId,
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

      if (commSetting && fee > 0) {
        await CommissionLedger.create([{
          userId,
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
      return { credited: { txHash: dep.txHash, gross, fee, netCredit, chain, name: dep.name } };
    }
    return { skipped: { txHash: dep.txHash, reason: 'tx-uncommitted' } };
  } catch (e) {
    if (e && e.code === 11000) {
      return { skipped: { txHash: dep.txHash, reason: 'already-credited' } };
    }
    console.error('[checkDeposits credit tx failed]', dep.txHash, e.message);
    return { skipped: { txHash: dep.txHash, reason: 'tx-failed', error: e.message } };
  } finally {
    session.endSession();
  }
}

// GET /user/wallet/cryptrum/withdrawals — filtered to this user via reference_id
// (we use Mongo Withdrawal._id as reference_id when pushing to Cryptrum).
exports.cryptrumWithdrawals = async (req, res) => {
  try {
    // Each Mongo Withdrawal._id is sent to Cryptrum as `reference_id`. Filter
    // /withdraw-list with our reference_id pattern is not supported per-row,
    // so we pull our local set and intersect against Cryptrum's full list.
    const userWithdrawals = await Withdrawal.find({
      userId: req.user._id,
      cryptrumCode: { $ne: null },
    }).select('cryptrumCode _id').lean();
    if (userWithdrawals.length === 0) {
      return res.json({ success: true, withdrawals: [], pagination: null });
    }
    const mineByCode = new Map();
    for (const w of userWithdrawals) mineByCode.set(w.cryptrumCode, w);

    const page = Number(req.query.page) || 1;
    const { withdrawals, pagination } = await cryptrum.getWithdrawList({ page });

    // Filter on our side so other users' codes never leak through.
    const mine = withdrawals.filter(w => mineByCode.has(w.code));
    res.json({ success: true, withdrawals: mine, pagination });
  } catch (err) {
    console.error('[Cryptrum]', req.originalUrl, err.message);
    res.status(err.status || 502).json({ success: false, message: err.message || 'Failed to load withdrawals' });
  }
};

// POST /user/wallet/deposit/address
// Body: { paymentMethodId: number }  — Cryptrum payment_method_id
// Returns an existing cached address from user.cryptoAddresses, or fetches a
// fresh one from Cryptrum and persists it on the user.
//
// EVM cross-asset safety net: when the requested method is EVM, every other
// EVM method we don't yet have cached is registered with Cryptrum in the same
// request. EVM addresses are HD-derived from one key, so the address is the
// same on all EVM chains — but Cryptrum's /deposit-list is filtered by
// (uniqueId × paymentMethodId), so without an upfront registration a user who
// opens "BNB" and accidentally sends USDT-BEP20 to that address would have no
// (uniqueId × BEP20-USDT) entry for Cryptrum to surface the deposit under.
// Registering all EVM methods at the first generation closes that gap.
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

    // Auto-register sibling EVM methods — best-effort, parallel. A single
    // sibling failure (rate limit, transient 5xx) must not fail the primary
    // request, so each result is checked independently.
    let registeredSiblings = 0;
    if (method.networkType === 'EVM') {
      const siblings = items.filter(m =>
        m.networkType === 'EVM' &&
        m.id !== paymentMethodId &&
        m.depositEnabled &&
        !user.cryptoAddresses.some(a => a.paymentMethodId === m.id),
      );

      if (siblings.length > 0) {
        const results = await Promise.allSettled(
          siblings.map(s =>
            cryptrum.fetchAddress(uniqueId, s.id).then(r => ({ method: s, address: r.address })),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.address) {
            user.cryptoAddresses.push({
              paymentMethodId: r.value.method.id,
              address:         r.value.address,
              name:            r.value.method.name,
              networkName:     r.value.method.networkName,
              networkType:     r.value.method.networkType,
              chainId:         r.value.method.chainId,
            });
            registeredSiblings++;
          } else if (r.status === 'rejected') {
            console.warn('[getDepositAddress] sibling register failed:', r.reason?.message);
          }
        }
      }
    }

    await user.save();

    res.json({
      success: true,
      address,
      paymentMethodId,
      chain: method.networkName,
      coinName: method.name,
      cached: false,
      siblingsRegistered: registeredSiblings,
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

// GET /user/wallet/deposit/status/:txHash[?paymentMethodId=&live=true]
//
// Default: cheap local-DB lookup against the Deposit collection (set by
// `checkDeposits` once the deposit has been credited).
//
// With `?live=true&paymentMethodId=<n>`: also queries Cryptrum's /deposit-list
// filtered to this txHash so the user can see in-flight phases (Pending /
// Queued for Verification / Hash Verified / Gas Transferred / Failed) before
// the local row exists. `paymentMethodId` is required because Cryptrum scopes
// the listing by uniqueId × paymentMethodId.
exports.depositStatus = async (req, res) => {
  try {
    const { txHash } = req.params;
    const wantLive   = req.query.live === 'true' || req.query.live === '1';
    const paymentMethodId = Number(req.query.paymentMethodId);

    const local = await Deposit.findOne({ txHash, userId: req.user._id });

    // Local row already in a terminal credit state — no need to call Cryptrum.
    const terminalLocal = local && ['confirmed', 'completed', 'rejected'].includes(local.status);
    if (terminalLocal && !wantLive) {
      return res.json({
        success: true,
        source: 'local',
        status: local.status,
        confirmations: local.confirmations,
        required: local.requiredConfs,
      });
    }

    if (!local && !wantLive) {
      return res.status(404).json({ success: false, message: 'Deposit not found' });
    }

    // Live lookup against Cryptrum (only if explicitly requested or local is non-terminal).
    if (wantLive) {
      if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
        return res.status(400).json({ success: false, message: 'paymentMethodId is required for live=true' });
      }

      const { deposits } = await cryptrum.getDepositList({
        uniqueId:        req.user._id.toString(),
        paymentMethodId,
        balanceSync:     1,
        thash:           txHash,
      });
      const remote = (deposits || []).find(d => d.txHash === txHash) || null;

      if (!remote && !local) {
        return res.status(404).json({ success: false, message: 'Deposit not found on Cryptrum or locally' });
      }

      return res.json({
        success: true,
        source: remote ? 'cryptrum' : 'local',
        // Cryptrum phase (0..5) — only present when remote row was returned.
        cryptrum: remote ? {
          status:      remote.status,
          statusCode:  remote.statusCode,
          statusLabel: remote.statusLabel,
          confirmed:   remote.confirmed,
          terminal:    remote.terminal,
        } : null,
        // Local credit state — present once checkDeposits has credited the wallet.
        local: local ? {
          status:        local.status,
          confirmations: local.confirmations,
          required:      local.requiredConfs,
          amount:        local.amount,
          chain:         local.chain,
          creditedAt:    local.creditedAt,
        } : null,
      });
    }

    // Local row exists but not terminal — caller can poll again.
    return res.json({
      success: true,
      source: 'local',
      status: local.status,
      confirmations: local.confirmations,
      required: local.requiredConfs,
    });
  } catch (err) {
    if (err.status === 502) {
      return res.status(502).json({ success: false, message: err.message });
    }
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
//
// Crypto withdrawals are auto-pushed to Cryptrum at submission — there is no
// admin approval step. The provider processes the payout on-chain; admins
// only monitor the resulting record.
//
// KYC is enforced at the route layer (`requireKyc` middleware) so it cannot
// be forgotten on new wallet-mutating endpoints.
//
// Defense layers (in order — first fail returns with no wallet mutation):
//   1. paymentMethodId validated as a positive integer.
//   2. Cryptrum is the source of truth for the network — we fetch the method
//      to confirm it exists, withdrawals are enabled, and derive the canonical
//      chain name + address family (never trust the caller's `chain` string).
//   3. Amount validated for type / range / decimals via `validateAmount`.
//   4. Address regex-validated against the derived family.
//   5. Atomic balance check + lock via `findOneAndUpdate` with a
//      `balance: { $gte: amount }` precondition. Race-safe: two concurrent
//      submits cannot both pass; one gets `null` and a 400.
//   6. Withdrawal row insert — pending until Cryptrum responds.
//   7. Push to Cryptrum. On success: promote to `approved`, release the lock
//      (funds are with the provider now). On failure: refund the user, delete
//      the row, return the provider error so the user can retry cleanly.
exports.initiateWithdraw = async (req, res) => {
  try {
    // KYC enforcement lives on the route (`requireKyc` middleware).

    // (1) paymentMethodId
    const paymentMethodId = Number(req.body.paymentMethodId);
    if (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0) {
      return res.status(400).json({ success: false, message: 'A valid paymentMethodId is required' });
    }

    // (2) Verify against Cryptrum — the provider is the source of truth.
    let method;
    try {
      const { items } = await cryptrum.getPaymentMethods('withdraw');
      method = items.find(m => m.id === paymentMethodId);
    } catch (e) {
      return res.status(e.status || 502).json({ success: false, message: e.message || 'Failed to verify network with provider' });
    }
    if (!method) {
      return res.status(400).json({ success: false, message: 'Unknown payment network' });
    }
    if (!method.withdrawEnabled) {
      return res.status(400).json({ success: false, message: `Withdrawals are currently disabled on ${method.networkName}` });
    }
    const chain  = String(method.networkName || '').toUpperCase();   // canonical
    const family = familyForMethod(method);

    // (3) Amount
    const amtResult = validateAmount(req.body.amount);
    if (!amtResult.ok) return res.status(400).json({ success: false, message: amtResult.error });
    const amount = amtResult.amount;

    // (4) Address
    const addrResult = validateAddress(req.body.toAddress, { chain, family });
    if (!addrResult.ok) return res.status(400).json({ success: false, message: addrResult.error });
    const toAddress = addrResult.address;

    // Commission resolution — must use the 3-layer resolver (user → merchant
    // → global). A previous inline lookup here skipped the merchant tier, so
    // MerchantCommissionSetting overrides for `withdrawal` were silently
    // inert. resolveCommission is the single read path documented in
    // lib/commissionResolver.js — all fee-calculation sites must go through it.
    const commSetting = await resolveCommission(req.user._id, 'withdrawal');
    let fee = 0;
    if (commSetting) {
      fee = commSetting.rateType === 'percentage'
        ? Math.round((amount * commSetting.rate) / 100 * 100) / 100
        : commSetting.rate;
    }
    const netAmount = Math.max(0, Math.round((amount - fee) * 100) / 100);

    // (5) Atomic check-and-debit — single round-trip verifies funds AND moves
    // them from balance → locked. Two parallel submits cannot both pass the
    // precondition, so over-withdrawal via double-click is impossible.
    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.user._id, balance: { $gte: amount } },
      { $inc: { balance: -amount, locked: amount } },
      { new: true },
    );
    if (!wallet) {
      const exists = await Wallet.exists({ userId: req.user._id });
      if (!exists) return res.status(404).json({ success: false, message: 'Wallet not found' });
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Refund helper — restores locked → balance. Always idempotent-safe via
    // the `locked: { $gte: amount }` precondition.
    const refundLock = () => Wallet.findOneAndUpdate(
      { userId: req.user._id, locked: { $gte: amount } },
      { $inc: { balance: amount, locked: -amount } },
    );

    // (6) Withdrawal row insert — roll back the lock if it fails
    let withdrawal;
    try {
      withdrawal = await Withdrawal.create({
        userId: req.user._id,
        chain,
        asset: 'USDT',
        amount,
        fee,
        toAddress,
        paymentMethodId,
        status: 'pending',
      });
    } catch (createErr) {
      await refundLock();
      throw createErr;
    }

    // (7) Auto-push to Cryptrum. Crypto withdrawals don't need admin approval
    // — the provider handles on-chain settlement directly. If the push fails,
    // refund the user and delete the row so they can re-submit without a
    // ghost "pending" entry sitting in their history.
    let cryptrumResp;
    try {
      cryptrumResp = await cryptrum.createWithdraw({
        referenceId:     withdrawal._id.toString(),
        paymentMethodId,
        amount,
        toAddress,
      });
    } catch (e) {
      await refundLock();
      await Withdrawal.deleteOne({ _id: withdrawal._id });
      console.error('[Cryptrum] initiateWithdraw push failed:', e.message);
      return res.status(e.status || 502).json({
        success: false,
        message: e.message || 'Cryptrum rejected the withdrawal — please try again.',
      });
    }

    // Provider accepted the payout: funds are now Cryptrum's responsibility,
    // so the lock MUST be released even if our subsequent bookkeeping fails.
    // A half-applied save would otherwise strand the user's funds in `locked`
    // while Cryptrum continues processing the payout. Wrap the post-push
    // steps so the lock release and cryptrumCode persistence always run.
    const cryptrumCode = cryptrumResp.withdrawCode || null;
    const txId = crypto.randomBytes(16).toString('hex');
    let reconciliationWarning = null;

    try {
      withdrawal.status       = 'approved';
      withdrawal.cryptrumCode = cryptrumCode;
      await withdrawal.save();

      await Wallet.findOneAndUpdate(
        { userId: req.user._id, locked: { $gte: amount } },
        { $inc: { locked: -amount } },
      );

      await WalletTransaction.create({
        userId: req.user._id,
        walletId: wallet._id,
        type: 'withdraw',
        amount,
        status: 'approved',
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
    } catch (postPushErr) {
      // Money already left to Cryptrum — DO NOT refund. Recover what we can
      // and surface a soft warning so ops can reconcile.
      console.error('[initiateWithdraw post-push] code=', cryptrumCode, 'err=', postPushErr);
      reconciliationWarning = 'Post-push reconciliation partially failed; ops will reconcile.';

      // Persist cryptrumCode no matter what — refreshWithdrawalStatus needs it.
      try {
        await Withdrawal.updateOne(
          { _id: withdrawal._id },
          { $set: { status: 'approved', cryptrumCode } },
        );
      } catch (e) {
        console.error('[initiateWithdraw post-push] Withdrawal save retry failed', e.message);
      }

      // Always release the lock — funds are no longer ours to hold.
      try {
        await Wallet.findOneAndUpdate(
          { userId: req.user._id, locked: { $gte: amount } },
          { $inc: { locked: -amount } },
        );
      } catch (e) {
        console.error('[initiateWithdraw post-push] Lock release failed', e.message);
      }
    }

    res.json({
      success: true,
      message: 'Withdrawal submitted to Cryptrum for on-chain processing',
      withdrawalId: withdrawal._id,
      cryptrumCode,
      reconciliationWarning,
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /user/wallet/withdraw/refresh-status
//
// For each of this user's withdrawals that has been pushed to Cryptrum
// (status=approved/processing, cryptrumCode set), query /withdraw-list and
// transition the local row based on the Cryptrum phase:
//   completed (1)              → status='completed' + txHash
//   unsuccessful (6)           → status='failed'    + refund balance
//   cancelled (7)              → status='rejected'  + refund balance
//   anything else (0/2/3/4/5)  → still in flight, leave alone
//
// Race-safety: every state transition uses a Withdrawal precondition
// (`status: { $in: ['approved', 'processing'] }`) so two parallel callers
// cannot both win the same transition — only one increments balance, only
// one writes the WalletTransaction terminal state. The completion path
// requires no wallet mutation (locked already released at approval); the
// failed/cancelled paths refund $amount back to balance from Cryptrum's
// retained funds.
exports.refreshWithdrawalStatus = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({
      userId:       req.user._id,
      cryptrumCode: { $ne: null },
      status:       { $in: ['approved', 'processing'] },  // non-terminal
    }).select('cryptrumCode status amount');

    const updated = [];

    for (const w of withdrawals) {
      let cryptrumData;
      try {
        cryptrumData = await cryptrum.getWithdrawList({ code: w.cryptrumCode });
      } catch (e) {
        // Skip on transient upstream error — caller can retry.
        console.error('[refreshWithdrawalStatus]', w.cryptrumCode, e.message);
        continue;
      }

      const item = (cryptrumData.withdrawals || [])[0];
      if (!item) continue;

      const txHash = item.txHash || null;

      // ── Completed (Cryptrum status 1) ─────────────────────────────────
      if (item.completed) {
        const w2 = await Withdrawal.findOneAndUpdate(
          { _id: w._id, status: { $in: ['approved', 'processing'] } },
          { $set: { status: 'completed', txHash, processedAt: new Date() } },
          { new: true },
        );
        if (w2) {
          await WalletTransaction.findOneAndUpdate(
            { referenceId: w._id.toString() },
            { $set: { status: 'completed', txHash, completedAt: new Date() } },
          );
          updated.push({ id: String(w._id), status: 'completed', statusCode: item.statusCode, txHash });
        }
        continue;
      }

      // ── Unsuccessful / Cancelled (Cryptrum status 6 or 7) ─────────────
      // Both are terminal-non-completed. Cryptrum still holds the funds
      // because the on-chain payout did not go through, so we credit the
      // user's wallet balance back.
      if (item.failed || item.cancelled) {
        const newStatus = item.cancelled ? 'rejected' : 'failed';
        const reason    = item.cancelled ? 'Cancelled by provider' : 'Provider reported unsuccessful';

        // Atomic transition — wins only if row hasn't already been moved.
        const w2 = await Withdrawal.findOneAndUpdate(
          { _id: w._id, status: { $in: ['approved', 'processing'] } },
          {
            $set: {
              status:          newStatus,
              rejectionReason: reason,
              processedAt:     new Date(),
              txHash,
            },
          },
          { new: true },
        );
        if (!w2) continue; // someone else already transitioned this row.

        // Refund the wallet — funds were debited at submission, Cryptrum
        // is not sending them out, so they come back to balance.
        try {
          await Wallet.findOneAndUpdate(
            { userId: req.user._id },
            { $inc: { balance: w.amount } },
          );
        } catch (e) {
          // Critical alert: row already marked terminal but refund failed.
          // Leave for ops reconciliation rather than rolling back the status.
          console.error('[refreshWithdrawalStatus] REFUND FAILED', w._id.toString(), e.message);
        }

        await WalletTransaction.findOneAndUpdate(
          { referenceId: w._id.toString() },
          { $set: { status: newStatus, completedAt: new Date(), notes: reason } },
        );

        updated.push({ id: String(w._id), status: newStatus, statusCode: item.statusCode, refunded: w.amount });
        continue;
      }

      // ── In-flight (0/2/3/4/5) — caller should re-poll ─────────────────
    }

    res.json({ success: true, checked: withdrawals.length, updated });
  } catch (err) {
    console.error('[500]', req.originalUrl, err);
    res.status(500).json({ success: false, message: 'Failed to refresh withdrawal status' });
  }
};

// GET /user/wallet/withdrawal/status/:id[?live=true]
//
// Default: local-DB read. Returns whatever refreshWithdrawalStatus last
// persisted (status, txHash).
//
// With `?live=true`: also queries Cryptrum /withdraw-list by cryptrumCode and
// returns the live phase (0..7) alongside the local row. Useful while a
// withdrawal is in-flight (status=approved/processing) and the user wants to
// see the exact Cryptrum stage (e.g., "Awaiting Blockchain Confirmation")
// without invoking the bulk refresh-status endpoint.
exports.withdrawalStatus = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, userId: req.user._id });
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });

    const wantLive = req.query.live === 'true' || req.query.live === '1';

    if (!wantLive || !withdrawal.cryptrumCode) {
      return res.json({
        success: true,
        source: 'local',
        status: withdrawal.status,
        txHash: withdrawal.txHash,
      });
    }

    let cryptrumData;
    try {
      cryptrumData = await cryptrum.getWithdrawList({ code: withdrawal.cryptrumCode });
    } catch (e) {
      // Upstream failure — fall back to local so the caller still gets useful info.
      return res.json({
        success: true,
        source: 'local',
        status: withdrawal.status,
        txHash: withdrawal.txHash,
        liveError: e.message,
      });
    }

    const item = (cryptrumData.withdrawals || [])[0] || null;
    return res.json({
      success: true,
      source: item ? 'cryptrum' : 'local',
      local: {
        status: withdrawal.status,
        txHash: withdrawal.txHash,
        amount: withdrawal.amount,
        chain:  withdrawal.chain,
      },
      cryptrum: item ? {
        status:         item.status,
        statusCode:     item.statusCode,
        statusLabel:    item.statusLabel,
        completed:      item.completed,
        failed:         item.failed,
        cancelled:      item.cancelled,
        terminal:       item.terminal,
        txHash:         item.txHash,
        txHashVerified: item.txHashVerified,
      } : null,
    });
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
