const crypto = require('crypto');
const Card = require('../../models/Card');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
const PhysicalCardNumber = require('../../models/PhysicalCardNumber');
const AppSetting = require('../../models/AppSetting');
const UqpayService = require('../../services/UqpayService');
const UqpayCardholder = require('../../models/UqpayCardholder');
const { toMoney, addMoney, subMoney, commissionAmount, isPositiveMoney, MoneyError } = require('../../lib/money');
const { resolveCommission } = require('../../lib/commissionResolver');

async function getSettingNumber(key, fallback) {
  const s = await AppSetting.findOne({ key });
  return s ? (Number(s.value) || fallback) : fallback;
}

function isPinWeak(pin) {
  // 3+ consecutive same digits
  if (/(\d)\1{2}/.test(pin)) return true;
  // Fully ascending or descending
  const d = pin.split('').map(Number);
  const asc  = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  const desc = d.every((v, i) => i === 0 || v === d[i - 1] - 1);
  if (asc || desc) return true;
  // Repeated 2-digit segment ABABAB (len 6)
  if (/^(\d{2})\1{2}$/.test(pin)) return true;
  // Repeated 3-digit segment ABCABC (len 6)
  if (/^(\d{3})\1$/.test(pin)) return true;
  return false;
}

// Atomically reserve the next available physical card number for this user.
// Priority: pre-assigned to this user → merchant pool → general pool.
async function reservePhysicalCardNumber(user) {
  const tryReserve = (filter) =>
    PhysicalCardNumber.findOneAndUpdate(
      filter,
      { $set: { isUsed: true, usedAt: new Date() } },
      { new: true, sort: { createdAt: 1 } }
    );

  let card = await tryReserve({ isUsed: false, preAssignedUserId: user._id });
  if (card) return card;

  if (user.merchantId) {
    card = await tryReserve({ isUsed: false, merchantId: user.merchantId, preAssignedUserId: null });
    if (card) return card;
  }

  return tryReserve({ isUsed: false, merchantId: null, preAssignedUserId: null });
}

// Release a reserved physical card number (rollback when UQPay fails).
async function releasePhysicalCardNumber(physCardId) {
  if (!physCardId) return;
  await PhysicalCardNumber.findByIdAndUpdate(physCardId, {
    $set: { isUsed: false, usedAt: null, cardId: null },
  });
}

// Delegate to the 3-tier resolver (User → Merchant → Global). Kept as a thin
// alias so existing call sites need not change.
async function getCommission(userId, type) {
  return resolveCommission(userId, type);
}

// ── UQPay Products (for card application form) ────────────────────────────

exports.getProducts = async (req, res) => {
  try {
    const data = await UqpayService.getProducts({ page_size: 50 });
    const products = data.data || data.products || data.items || [];
    res.json({ success: true, products });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Check Holder Duplicate (AJAX) ─────────────────────────────────────────

exports.checkHolder = async (req, res) => {
  try {
    const { field, value } = req.query;
    if (!['email', 'mobile'].includes(field) || !value) {
      return res.json({ available: false, message: 'Invalid request.' });
    }
    const col = field === 'email' ? 'holderEmail' : 'holderMobile';
    const exists = await Card.exists({ [col]: value.trim(), status: { $ne: 'cancelled' } });
    res.json({
      available: !exists,
      message: exists
        ? (field === 'email' ? 'This email is already linked to another card.' : 'This mobile number is already linked to another card.')
        : 'Available',
    });
  } catch (err) {
    res.json({ available: false, message: err.message });
  }
};

// ── Card Fee Summary ──────────────────────────────────────────────────────

exports.getCardFees = async (req, res) => {
  try {
    const calc = async (type, defaultMin) => {
      const minDeposit = await getSettingNumber(
        type === 'card_issuance_physical' ? 'physical_card_min_deposit' : 'virtual_card_min_deposit',
        defaultMin
      );
      let commSetting = await getCommission(req.user._id, type);
      if (!commSetting) commSetting = await getCommission(req.user._id, 'card_issuance');

      const safeMin  = toMoney(minDeposit, 'minDeposit');
      const rateType = commSetting?.rateType === 'fixed' ? 'fixed' : 'percentage';
      const rate     = Number.isFinite(Number(commSetting?.rate)) && Number(commSetting?.rate) >= 0 ? Number(commSetting.rate) : 0;
      const fee      = commSetting ? commissionAmount(safeMin, rate, rateType) : 0;
      const feePct   = rateType === 'percentage' ? rate : 0;
      return { min_deposit: safeMin, fee_pct: feePct, issuance_fee: fee, total: addMoney(safeMin, fee) };
    };

    const safeRate = (setting) => {
      const rateType = setting?.rateType === 'fixed' ? 'fixed' : 'percentage';
      const rate     = Number.isFinite(Number(setting?.rate)) && Number(setting?.rate) >= 0 ? Number(setting.rate) : 0;
      return { rateType, rate };
    };
    const calcDeposit = async () => {
      const setting = await getCommission(req.user._id, 'card_deposit');
      return { ...safeRate(setting), min_amount: 30 };
    };
    const calcWithdraw = async () => {
      const setting = await getCommission(req.user._id, 'card_withdrawal');
      return safeRate(setting);
    };

    const [virtual, physical, deposit, withdraw] = await Promise.all([
      calc('card_issuance_virtual', 10),
      calc('card_issuance_physical', 50),
      calcDeposit(),
      calcWithdraw(),
    ]);

    res.json({ success: true, virtual, physical, deposit, withdraw });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Physical Card Availability (mirrors PHP merchantHasPhysicalCards) ────
//
// Priority for a user:
//   1) any card pre-assigned to this user (any merchant) → available.
//   2) if user belongs to a merchant: any unused card in that merchant pool that
//      is not pre-assigned to anyone else → available; otherwise NOT available.
//   3) if user has no merchant: any unused card in the general pool (no merchant,
//      no pre-assignment) → available.
exports.physicalAvailable = async (req, res) => {
  try {
    const user = req.user;

    const hasPreAssigned = await PhysicalCardNumber.exists({
      preAssignedUserId: user._id,
      isUsed: false,
    });
    if (hasPreAssigned) return res.json({ success: true, available: true, source: 'preassigned' });

    if (user.merchantId) {
      const hasMerchant = await PhysicalCardNumber.exists({
        merchantId: user.merchantId,
        isUsed: false,
        preAssignedUserId: null,
      });
      return res.json({ success: true, available: !!hasMerchant, source: hasMerchant ? 'merchant' : null });
    }

    const hasGeneral = await PhysicalCardNumber.exists({
      merchantId: null,
      isUsed: false,
      preAssignedUserId: null,
    });
    res.json({ success: true, available: !!hasGeneral, source: hasGeneral ? 'general' : null });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── List Cards ────────────────────────────────────────────────────────────

exports.listCards = async (req, res) => {
  try {
    const cards = await Card.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, cards });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Get Card (syncs balance/status from UQPay) ───────────────────────────

function mapUqpayStatus(s = '') {
  const u = s.toUpperCase();
  if (u === 'ACTIVE')    return 'active';
  if (u === 'FROZEN')    return 'frozen';
  if (u === 'CANCELLED') return 'cancelled';
  if (u === 'PENDING')   return 'pending';
  return s.toLowerCase() || 'pending';
}

exports.getCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    if (card.uqpayCardId) {
      try {
        const info    = await UqpayService.getCardInfo(card.uqpayCardId);
        const status  = mapUqpayStatus(info.card_status || '');
        const balance = parseFloat(info.balance ?? info.available_balance ?? card.balance);
        if (status !== card.status || (!isNaN(balance) && balance !== card.balance)) {
          card.status  = status;
          if (!isNaN(balance)) card.balance = balance;
          await card.save();
        }
      } catch (e) {
        console.error('[getCard] UQPay sync failed:', e.response?.data || e.message);
      }
    }

    res.json({ success: true, card });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Apply / Issue Card ────────────────────────────────────────────────────

exports.applyCard = async (req, res) => {
  try {
    const {
      cardType        = 'virtual',
      card_product_id,
      card_currency   = 'USD',
      card_mode       = 'SINGLE',       // SINGLE | SHARE — required for physical assign
      depositAmount   : depositAmt,
      delivery,                          // physical card delivery info: { name, address, city, country, postalCode, phone }
    } = req.body;

    if (!['virtual', 'physical'].includes(cardType)) {
      return res.status(400).json({ success: false, message: 'Invalid card type.' });
    }

    if (cardType === 'physical') {
      const d = delivery || {};
      const missing = ['name', 'address', 'city', 'country', 'postalCode', 'phone']
        .filter(k => !d[k] || !String(d[k]).trim());
      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: 'Missing delivery details: ' + missing.join(', '),
        });
      }
    }

    if (req.user.kycStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC approval required to apply for a card.' });
    }

    if (!card_product_id) {
      return res.status(400).json({ success: false, message: 'Please select a card product.' });
    }

    const user   = req.user;
    const walletExists = await Wallet.exists({ userId: user._id });
    if (!walletExists) return res.status(404).json({ success: false, message: 'Wallet not found' });

    const issuanceType = cardType === 'physical' ? 'card_issuance_physical' : 'card_issuance_virtual';
    let commSetting = await getCommission(user._id, issuanceType);
    if (!commSetting) commSetting = await getCommission(user._id, 'card_issuance');

    const defaultMin    = cardType === 'physical'
      ? await getSettingNumber('physical_card_min_deposit', 50)
      : await getSettingNumber('virtual_card_min_deposit', 10);

    // Money math goes through the helper so a non-finite / negative / over-cap
    // input throws MoneyError → controller returns 400 instead of writing junk.
    let depositAmount, feeAmount, totalCharge;
    try {
      const raw = Number(depositAmt);
      depositAmount = isPositiveMoney(raw) ? toMoney(raw, 'depositAmount') : toMoney(defaultMin, 'depositAmount');
      feeAmount     = commSetting ? commissionAmount(depositAmount, commSetting.rate, commSetting.rateType) : 0;
      totalCharge   = addMoney(depositAmount, feeAmount);
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }

    // ── Find or create UQPay cardholder for this user ─────────────────────
    let cardholder = await UqpayCardholder.findOne({ userId: user._id });

    if (!cardholder) {
      const countryCode = (user.country || '').trim().toUpperCase();
      const phoneNumber = (user.mobile || '').replace(/\D/g, '');

      if (!countryCode || !phoneNumber) {
        return res.status(400).json({
          success: false,
          message: 'Please complete your profile (country and mobile number) before applying for a card.',
        });
      }

      const cardholderPayload = {
        userId      : user._id,
        email       : user.email,
        first_name  : (user.firstName || (user.name || '').split(' ')[0] || 'User').trim(),
        last_name   : (user.lastName  || (user.name || '').split(' ').slice(1).join(' ') || 'User').trim(),
        country_code: countryCode,
        phone_number: phoneNumber,
      };

      // Optional KYC text fields — only include when we can map safely.
      const dob = user.birthday || user.kycDob;
      if (dob) {
        const d = new Date(dob);
        if (!isNaN(d)) cardholderPayload.date_of_birth = d.toISOString().slice(0, 10);
      }
      // UQPay accepts only MALE or FEMALE — skip "other" / "prefer-not-to-say" / blank.
      const genderMap = { male: 'MALE', female: 'FEMALE', m: 'MALE', f: 'FEMALE' };
      const g = (user.gender || '').toString().trim().toLowerCase();
      if (genderMap[g]) cardholderPayload.gender = genderMap[g];

      // UQPay's `identity` object holds the ID document metadata.
      // (`document_type` and `document` are for the actual file upload — file extension + base64 content —
      // which we don't have wired yet, so we only send the structured identity fields.)
      // UQPay's identity.type accepts only PASSPORT or ID_CARD.
      // National IDs and driver's licenses both map to ID_CARD (closest equivalent).
      const idTypeMap = {
        passport: 'PASSPORT',
        national_id: 'ID_CARD', id_card: 'ID_CARD', nid: 'ID_CARD',
        drivers_license: 'ID_CARD', driver_license: 'ID_CARD', dl: 'ID_CARD',
      };
      const dt = (user.kycDocType || '').toString().trim().toLowerCase();
      if (idTypeMap[dt] && user.kycIdNumber) {
        cardholderPayload.identity = {
          type  : idTypeMap[dt],
          number: String(user.kycIdNumber).trim(),
        };
      }

      console.log('[applyCard] Creating UQPay cardholder with payload:', cardholderPayload);

      try {
        cardholder = await UqpayService.createCardholder(cardholderPayload);
      } catch (chErr) {
        const errData = chErr.response?.data;
        console.error('[applyCard] UQPay cardholder rejected:', JSON.stringify(errData || chErr.message));

        // Retry once with only the bare-minimum required fields so a bad optional
        // field (date format, gender enum, document mapping) doesn't block the user.
        try {
          cardholder = await UqpayService.createCardholder({
            userId      : user._id,
            email       : cardholderPayload.email,
            first_name  : cardholderPayload.first_name,
            last_name   : cardholderPayload.last_name,
            country_code: cardholderPayload.country_code,
            phone_number: cardholderPayload.phone_number,
          });
          console.log('[applyCard] Cardholder created on minimal-payload retry');
        } catch (retryErr) {
          const msg = retryErr.response?.data?.message || retryErr.response?.data?.error || retryErr.message
                    || errData?.message || errData?.error || chErr.message;
          return res.status(422).json({ success: false, message: 'Cardholder creation failed: ' + msg });
        }
      }
    }

    // ── For PHYSICAL: reserve a card number from inventory BEFORE charging wallet ──
    let physCard = null;
    if (cardType === 'physical') {
      physCard = await reservePhysicalCardNumber(user);
      if (!physCard) {
        return res.status(409).json({
          success: false,
          message: 'No physical card available. Please contact your merchant or admin to assign one.',
        });
      }
    }

    // ── PHASE 1: atomic wallet debit + create local Card record ──────────
    const txnId = 'CARD-' + crypto.randomBytes(8).toString('hex').toUpperCase();

    // Atomic check-and-debit. In a single Mongo round-trip the balance
    // precondition is verified AND the deduction is applied. Two parallel
    // applyCard calls cannot both pass — the second sees null and returns
    // 400. No "lost update" race possible here.
    const wallet = await Wallet.findOneAndUpdate(
      { userId: user._id, balance: { $gte: totalCharge } },
      { $inc: { balance: -totalCharge } },
      { new: true },
    );
    if (!wallet) {
      // Either wallet was deleted between the exists() check and now (very
      // rare), or balance is insufficient. Release the reserved physical card.
      if (physCard) {
        try { await releasePhysicalCardNumber(physCard._id); }
        catch (e) { console.error('[applyCard] phys release failed after debit guard: %s', e.message); }
      }
      const current = await Wallet.findOne({ userId: user._id }).select('balance');
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Need $${totalCharge.toFixed(2)} but wallet has $${Number(current?.balance ?? 0).toFixed(2)}.`,
      });
    }

    const card = await Card.create({
      userId            : user._id,
      uqpayCardholderId : cardholder.cardholder_id,
      currency          : card_currency,
      cardType,
      cardNo            : physCard ? physCard.cardNumber : null,
      status            : 'processing',
      balance           : 0,
      depositAmount,
      feeAmount,
      deliveryInfo      : cardType === 'physical' ? delivery : null,
    });

    if (physCard) {
      await PhysicalCardNumber.findByIdAndUpdate(physCard._id, { cardId: card._id });
    }

    // Ledger writes are best-effort observability — if either fails, the
    // wallet is still consistent because the debit already landed atomically.
    // Failures are loudly logged so a reconciler / operator can backfill.
    try {
      await WalletTransaction.create({
        userId        : user._id,
        walletId      : wallet._id,
        type          : 'card_issuance',
        amount        : totalCharge,
        status        : 'completed',
        transactionId : txnId,
      });
    } catch (e) {
      console.error('[applyCard] WalletTransaction write failed for txnId=%s userId=%s: %s', txnId, user._id, e.message);
    }

    if (commSetting && feeAmount > 0) {
      try {
        await CommissionLedger.create({
          userId          : user._id,
          transactionId   : txnId,
          type            : issuanceType,
          grossAmount     : totalCharge,
          commissionAmount: feeAmount,
          netAmount       : depositAmount,
          rateType        : commSetting.rateType,
          rate            : commSetting.rate,
        });
      } catch (e) {
        console.error('[applyCard] CommissionLedger write failed for txnId=%s userId=%s: %s', txnId, user._id, e.message);
      }
    }

    // ── PHASE 2: issue card on UQPay (assign for physical, create for virtual) ──
    let uqpayCard;
    try {
      if (cardType === 'physical') {
        uqpayCard = await UqpayService.assignCard({
          cardholder_id : cardholder.cardholder_id,
          card_number   : physCard.cardNumber,
          card_currency,
          card_mode,
          card_product_id,
          cardholderId  : cardholder._id,
          userId        : user._id,
        });
      } else {
        uqpayCard = await UqpayService.createCard({
          card_currency,
          cardholder_id : cardholder.cardholder_id,
          card_product_id,
          cardholderId  : cardholder._id,
          userId        : user._id,
        });
      }
    } catch (uqErr) {
      // Each rollback step runs independently so a single failure (Mongo blip,
      // missing doc, validation error) cannot skip the remaining ones. Any
      // residual inconsistency is logged loudly with the card id so an
      // operator (or a future reconciler) can fix it by hand.
      const residual = [];

      // 1. Refund the wallet — use atomic $inc against the document so a
      //    stale in-memory `wallet` (e.g. modified by a concurrent admin
      //    credit during the UQPay call) cannot clobber the live value.
      try {
        await Wallet.findOneAndUpdate(
          { userId: user._id },
          { $inc: { balance: totalCharge } },
        );
      } catch (refundErr) {
        residual.push(`wallet_refund_failed:${refundErr.message}`);
      }

      // 2. Mark the local Card row failed so it cannot be confused with
      //    a real provider-backed card.
      try {
        await Card.findByIdAndUpdate(card._id, { status: 'failed' });
      } catch (markErr) {
        residual.push(`card_mark_failed:${markErr.message}`);
      }

      // 3. Release the physical card number back to inventory.
      if (physCard) {
        try {
          await releasePhysicalCardNumber(physCard._id);
        } catch (relErr) {
          residual.push(`physcard_release_failed:${physCard._id}:${relErr.message}`);
        }
      }

      const errData = uqErr.response?.data;
      console.error('[UQPay] Card issuance failed for cardId=%s userId=%s: %s', card._id, user._id, JSON.stringify(errData || uqErr.message));
      if (residual.length) {
        console.error('[applyCard] ROLLBACK INCONSISTENCY cardId=%s userId=%s steps=%j — needs manual reconcile', card._id, user._id, residual);
      }
      const msg = errData?.message || errData?.error || errData?.msg || uqErr.message || 'Card issuance failed. Please try again.';
      return res.status(422).json({ success: false, message: msg });
    }

    await Card.findByIdAndUpdate(card._id, {
      uqpayCardId : uqpayCard.card_id,
      status      : 'pending',
    });

    res.status(201).json({
      success : true,
      message : `${cardType} card issued successfully! $${totalCharge.toFixed(2)} deducted from wallet.`,
      cardId  : card._id,
      cardNo  : physCard ? physCard.cardNumber : null,
    });
  } catch (err) {
    const errData = err.response?.data;
    console.error('[applyCard] Unexpected error:', JSON.stringify(errData || err.message));
    const msg = errData?.message || errData?.error || errData?.msg || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// ── Transactions (paginated) ──────────────────────────────────────────────

exports.cardTransactions = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (!card.uqpayCardId) {
      return res.status(404).json({ success: false, message: 'Card provider reference not found' });
    }

    const pageNum  = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;
    const tab      = req.query.tab === 'authorizations' ? 'authorizations' : 'transactions';

    const params = { page_size: pageSize, page_number: pageNum };
    if (req.query.start) params.start_time = req.query.start + ' 00:00:00';
    if (req.query.end)   params.end_time   = req.query.end   + ' 23:59:59';

    const emptyResult = () => res.json({
      success: true, tab, transactions: [], total: 0, page: pageNum, lastPage: 1,
    });

    try {
      const result = tab === 'authorizations'
        ? await UqpayService.getCardAuthorizations(card.uqpayCardId, params)
        : await UqpayService.getCardOrders(card.uqpayCardId, params);

      const extractItems = (r) => {
        if (Array.isArray(r)) return r;
        if (!r || typeof r !== 'object') return [];
        for (const k of ['records', 'orders', 'items', 'list', 'data']) {
          if (Array.isArray(r[k])) return r[k];
        }
        if (r.data && typeof r.data === 'object') return extractItems(r.data);
        return [];
      };
      const extractTotal = (r, fallback) => {
        if (!r || typeof r !== 'object') return fallback;
        if (r.total_count != null) return Number(r.total_count) || fallback;
        if (r.total       != null) return Number(r.total)       || fallback;
        if (r.data && typeof r.data === 'object') return extractTotal(r.data, fallback);
        return fallback;
      };

      const items = extractItems(result);
      const total = extractTotal(result, items.length);

      return res.json({
        success     : true,
        tab,
        transactions: items.map(t => ({
          description: t.description || t.merchant_name || t.order_type || t.type || (tab === 'authorizations' ? 'Authorization' : 'Transaction'),
          amount     : t.amount       || t.transaction_amount || 0,
          currency   : t.currency     || t.transaction_currency || card.currency,
          date       : t.create_time  || t.created_at || t.auth_time || t.createdAt,
          type       : t.order_type   || t.type,
          status     : t.order_status || t.auth_status || t.status,
          reference  : t.order_id     || t.authorization_id || t.id,
        })),
        total,
        page    : pageNum,
        lastPage: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (e) {
      const status = e.response?.status;
      const msg    = e.response?.data?.message || e.response?.data?.error || e.message || '';

      // UQPay returns 404 / "not exists" when a card has no orders or auths yet — treat as empty.
      if (status === 404 || /not\s*exists?|no\s*record|empty/i.test(msg)) {
        return emptyResult();
      }
      return res.status(422).json({ success: false, message: msg || 'Failed to load card history' });
    }
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Card Deposit (Load) ──────────────────────────────────────────────────
//
// Flow:
//   1. Atomically check + debit wallet (one Mongo round-trip).
//   2. Call UQPay rechargeCard.
//   3. On UQPay success: $inc card.balance, write ledger.
//   4. On UQPay failure: atomic $inc refund to wallet, return 422.
//
// Previously UQPay was called BEFORE the wallet debit — if the wallet save
// then failed (Mongo blip, process kill, replica failover), the user got a
// free card-balance increase. Wallet-first + atomic refund closes that gap.

exports.depositCard = async (req, res) => {
  try {
    // 1. Validate input + load card + load commission via money helper.
    let amount, fee, totalCharge, rateType, rate;
    try {
      amount = toMoney(req.body.amount, 'amount');
      if (amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Deposit is only available for active cards.' });
    if (!card.uqpayCardId)        return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    const commSetting = await resolveCommission(req.user._id, 'card_deposit');
    rateType = commSetting?.rateType === 'fixed' ? 'fixed' : 'percentage';
    rate     = Number.isFinite(Number(commSetting?.rate)) && Number(commSetting?.rate) >= 0 ? Number(commSetting.rate) : 0;
    try {
      fee         = commSetting ? commissionAmount(amount, rate, rateType) : 0;
      totalCharge = addMoney(amount, fee);
    } catch (e) {
      if (e instanceof MoneyError) return res.status(500).json({ success: false, message: 'Deposit math produced an invalid value. Please contact support.' });
      throw e;
    }

    // 2. Atomic wallet debit. Precondition guards against race + insufficient
    //    balance in a single round-trip. The deduction is final before we
    //    touch the provider.
    const wallet = await Wallet.findOneAndUpdate(
      { userId: req.user._id, balance: { $gte: totalCharge } },
      { $inc: { balance: -totalCharge } },
      { new: true },
    );
    if (!wallet) {
      const current = await Wallet.findOne({ userId: req.user._id }).select('balance');
      if (!current) return res.status(404).json({ success: false, message: 'Wallet not found' });
      const feeLabel = rateType === 'fixed' ? `fixed fee $${fee.toFixed(2)}` : `${rate}% fee $${fee.toFixed(2)}`;
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Need $${totalCharge.toFixed(2)} (deposit $${amount.toFixed(2)} + ${feeLabel}). Your balance: $${Number(current.balance).toFixed(2)}.`,
      });
    }

    // 3. Call UQPay. If it throws, we must refund the wallet atomically and
    //    surface the provider error. Never leave funds debited without a
    //    matching card-side load.
    try {
      await UqpayService.rechargeCard(card.uqpayCardId, amount);
    } catch (e) {
      try {
        await Wallet.findOneAndUpdate(
          { userId: req.user._id },
          { $inc: { balance: totalCharge } },
        );
      } catch (refundErr) {
        console.error('[depositCard] REFUND FAILED userId=%s cardId=%s totalCharge=%s err=%s — needs manual reconcile',
          req.user._id, card._id, totalCharge, refundErr.message);
      }
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Deposit failed. Please try again.' });
    }

    // 4. UQPay succeeded — bump local card balance atomically and write the
    //    ledger rows. Failures here are observability gaps; wallet/UQPay
    //    are already consistent so we still return success but log loudly.
    const updatedCard = await Card.findByIdAndUpdate(
      card._id,
      { $inc: { balance: amount } },
      { new: true },
    );

    const txnId = 'CDEP-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    try {
      await WalletTransaction.create({
        userId: req.user._id, walletId: wallet._id,
        type: 'card_deposit', amount: totalCharge, status: 'completed',
        transactionId: txnId,
      });
    } catch (e) {
      console.error('[depositCard] WalletTransaction write failed txnId=%s userId=%s: %s', txnId, req.user._id, e.message);
    }

    if (fee > 0) {
      try {
        await CommissionLedger.create({
          userId: req.user._id, transactionId: txnId, type: 'card_deposit',
          grossAmount: totalCharge, commissionAmount: fee, netAmount: amount,
          rateType, rate,
        });
      } catch (e) {
        console.error('[depositCard] CommissionLedger write failed txnId=%s userId=%s: %s', txnId, req.user._id, e.message);
      }
    }

    res.json({
      success: true,
      message: `Deposit of $${amount.toFixed(2)} successful.`,
      fee,
      newBalance: updatedCard?.balance ?? toMoney(addMoney(card.balance, amount), 'newBalance'),
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Withdraw from Card ────────────────────────────────────────────────────
//
// UQPay is the source of truth for card balance, so we call UQPay first to
// debit the card, then atomically credit the wallet via $inc. If the local
// wallet credit fails after a successful UQPay debit, the discrepancy is
// loudly logged for manual recovery — the user has lost card balance and
// must be made whole.

exports.withdrawFromCard = async (req, res) => {
  try {
    let amount, fee, credited, rateType, rate;
    try {
      amount = toMoney(req.body.amount, 'amount');
      if (amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
    } catch (e) {
      if (e instanceof MoneyError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Withdraw is only available for active cards.' });
    if (!card.uqpayCardId)        return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    const commSetting = await resolveCommission(req.user._id, 'card_withdrawal');
    rateType = commSetting?.rateType === 'fixed' ? 'fixed' : 'percentage';
    rate     = Number.isFinite(Number(commSetting?.rate)) && Number(commSetting?.rate) >= 0 ? Number(commSetting.rate) : 0;
    try {
      fee      = commSetting ? commissionAmount(amount, rate, rateType) : 0;
      credited = subMoney(amount, fee);
    } catch (e) {
      if (e instanceof MoneyError) return res.status(500).json({ success: false, message: 'Withdrawal math produced an invalid value. Please contact support.' });
      throw e;
    }

    if (credited <= 0) {
      const feeLabel = rateType === 'fixed' ? `fixed fee $${fee.toFixed(2)}` : `${rate}% fee $${fee.toFixed(2)}`;
      return res.status(400).json({
        success: false,
        message: `Withdraw amount must exceed the ${feeLabel}.`,
      });
    }

    // Provider debit first (UQPay is the source of truth for card balance).
    try {
      await UqpayService.withdrawCard(card.uqpayCardId, amount);
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Withdraw failed. Please try again.' });
    }

    // Atomic wallet credit. If this fails, UQPay has already debited the
    // card — log loudly so an operator can make the user whole.
    let wallet;
    try {
      wallet = await Wallet.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { balance: credited } },
        { new: true, upsert: false },
      );
      if (!wallet) throw new Error('wallet not found');
    } catch (e) {
      console.error('[withdrawFromCard] WALLET CREDIT FAILED after UQPay debit — userId=%s cardId=%s amount=%s credited=%s err=%s — manual reconcile required',
        req.user._id, card._id, amount, credited, e.message);
      return res.status(500).json({
        success: false,
        message: 'Card debit succeeded but wallet credit failed. Support has been notified.',
      });
    }

    // Local card balance mirror — best-effort. UQPay is authoritative.
    const updatedCard = await Card.findByIdAndUpdate(
      card._id,
      { $inc: { balance: -amount } },
      { new: true },
    );

    const txnId = 'WDR-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    try {
      await WalletTransaction.create({
        userId: req.user._id, walletId: wallet._id,
        type: 'card_withdraw', amount, status: 'completed',
        transactionId: txnId,
      });
    } catch (e) {
      console.error('[withdrawFromCard] WalletTransaction write failed txnId=%s userId=%s: %s', txnId, req.user._id, e.message);
    }

    if (fee > 0) {
      try {
        await CommissionLedger.create({
          userId: req.user._id, transactionId: txnId, type: 'card_withdrawal',
          grossAmount: amount, commissionAmount: fee, netAmount: credited,
          rateType, rate,
        });
      } catch (e) {
        console.error('[withdrawFromCard] CommissionLedger write failed txnId=%s userId=%s: %s', txnId, req.user._id, e.message);
      }
    }

    res.json({
      success: true,
      message: `$${credited.toFixed(2)} credited to wallet ($${amount.toFixed(2)} withdrawn, $${fee.toFixed(2)} fee).`,
      fee,
      credited,
      newBalance: updatedCard?.balance ?? toMoney(subMoney(card.balance, amount), 'newBalance'),
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Freeze ────────────────────────────────────────────────────────────────

exports.freezeCard = async (req, res) => {
  try {
    // Atomic claim: transition active → frozen. Two parallel freeze requests
    // (or freeze + terminate) cannot both pass — only the matched query proceeds
    // to call UQPay and to write the local state. Loser gets 409.
    const card = await Card.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'active' },
      { $set: { status: 'frozen' } },
      { new: true },
    );
    if (!card) {
      const exists = await Card.findOne({ _id: req.params.id, userId: req.user._id }).select('status uqpayCardId');
      if (!exists)            return res.status(404).json({ success: false, message: 'Card not found' });
      if (!exists.uqpayCardId) return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
      return res.status(409).json({ success: false, message: 'Only active cards can be frozen.' });
    }
    if (!card.uqpayCardId) {
      // Roll the local state back and refuse — we hold the only claim, no race.
      await Card.findByIdAndUpdate(card._id, { $set: { status: 'active' } });
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'FROZEN', 'User requested freeze');
    } catch (e) {
      // UQPay refused — undo the local claim so state stays consistent.
      await Card.findByIdAndUpdate(card._id, { $set: { status: 'active' } });
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to freeze card. Please try again.' });
    }

    res.json({ success: true, message: 'Card has been frozen successfully.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Unfreeze ──────────────────────────────────────────────────────────────

exports.unfreezeCard = async (req, res) => {
  try {
    // Atomic claim: transition frozen → active.
    const card = await Card.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'frozen' },
      { $set: { status: 'active' } },
      { new: true },
    );
    if (!card) {
      const exists = await Card.findOne({ _id: req.params.id, userId: req.user._id }).select('status uqpayCardId');
      if (!exists)            return res.status(404).json({ success: false, message: 'Card not found' });
      if (!exists.uqpayCardId) return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
      return res.status(409).json({ success: false, message: 'Only frozen cards can be unfrozen.' });
    }
    if (!card.uqpayCardId) {
      await Card.findByIdAndUpdate(card._id, { $set: { status: 'frozen' } });
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'ACTIVE', 'User requested unfreeze');
    } catch (e) {
      await Card.findByIdAndUpdate(card._id, { $set: { status: 'frozen' } });
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to unfreeze card. Please try again.' });
    }

    res.json({ success: true, message: 'Card has been unfrozen successfully.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Terminate ─────────────────────────────────────────────────────────────

exports.terminateCard = async (req, res) => {
  try {
    // Atomic claim: anything-not-cancelled → cancelled. Only one concurrent
    // terminate (or terminate vs freeze) succeeds; the loser sees 409.
    const card = await Card.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled' }, $currentDate: { updatedAt: true } },
      { new: true },
    );
    if (!card) {
      const exists = await Card.findOne({ _id: req.params.id, userId: req.user._id }).select('status uqpayCardId');
      if (!exists) return res.status(404).json({ success: false, message: 'Card not found' });
      return res.status(409).json({ success: false, message: 'Card is already terminated.' });
    }
    if (!card.uqpayCardId) {
      // We have no provider id to act on — refuse and roll back local claim.
      // The prior status is unknown atomically; flag for manual recovery.
      console.error('[terminateCard] card %s claimed cancelled locally but no uqpayCardId — needs reconcile', card._id);
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'CANCELLED', 'User requested termination');
    } catch (e) {
      // UQPay refused — best-effort roll local back. We do NOT know the
      // pre-claim status atomically; surface to ops via log.
      console.error('[terminateCard] UQPay refused for card %s — local stamped cancelled; manual review needed: %s', card._id, e.message);
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to terminate card. Please try again.' });
    }

    res.json({ success: true, message: 'Card has been permanently terminated.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Reveal Card (AJAX) ────────────────────────────────────────────────────

exports.revealCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (!card.uqpayCardId) return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    // Sync latest status from UQPay before checking — card may still be 'pending' in DB
    // even though UQPay already activated it
    try {
      const latest = await UqpayService.getCardInfo(card.uqpayCardId);
      const synced = mapUqpayStatus(latest.card_status || '');
      if (synced !== card.status) {
        card.status = synced;
        await card.save();
      }
    } catch (syncErr) {
      console.error('[revealCard] UQPay status sync failed:', syncErr.response?.data || syncErr.message);
    }

    if (!['active', 'frozen'].includes(card.status)) {
      return res.status(422).json({ success: false, message: `Card cannot be revealed in status: ${card.status}.` });
    }

    let info;
    try {
      info = await UqpayService.getCardSensitiveInfo(card.uqpayCardId);
    } catch (e) {
      // Do NOT log e.response.data — provider error bodies may contain PAN/CVV echoes.
      console.error('[revealCard] UQPay secure error: status=%s message=%s', e.response?.status, e.message);
      const msg = e.response?.data?.message || e.response?.data?.error || e.response?.data?.msg || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to retrieve card details from provider.' });
    }

    res.json({
      success    : true,
      cardDetails: {
        cardNumber : info.card_number  || info.cardNumber  || info.pan          || '',
        cvv        : info.cvv          || info.cvc         || info.cvv2         || '',
        expireDate : info.expiry_date  || info.expireDate  || info.expire_date  || info.expiry || '',
      },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Refresh Balance (AJAX) ────────────────────────────────────────────────

exports.refreshBalance = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    if (card.uqpayCardId) {
      try {
        const info    = await UqpayService.getCardInfo(card.uqpayCardId);
        const status  = mapUqpayStatus(info.card_status || '');
        const balance = parseFloat(info.balance ?? info.available_balance ?? card.balance);
        card.status   = status;
        if (!isNaN(balance)) card.balance = balance;
        await card.save();
      } catch (e) {
        console.error('[refreshBalance] UQPay sync failed:', e.response?.data || e.message);
      }
    }

    res.json({ success: true, balance: card.balance, status: card.status });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Activate Physical Card ────────────────────────────────────────────────
// Note: UQPay auto-activates issued cards. This endpoint sets a PIN and refreshes
// the live status from UQPay so the local record matches.

exports.activateCard = async (req, res) => {
  try {
    const { pin, pinConfirmation } = req.body;
    const noPinAmountRaw = req.body.no_pin_amount;

    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be exactly 6 digits.' });
    }
    if (pin !== pinConfirmation) {
      return res.status(400).json({ success: false, message: 'PIN confirmation does not match.' });
    }
    if (isPinWeak(pin)) {
      return res.status(400).json({ success: false, message: 'PIN is too simple. Avoid repeated, ascending, or descending digits.' });
    }

    // Contactless / no-PIN payment limit (0–2000 in card currency). Optional.
    let noPinAmount = null;
    if (noPinAmountRaw !== undefined && noPinAmountRaw !== '' && noPinAmountRaw !== null) {
      noPinAmount = Number(noPinAmountRaw);
      if (!Number.isFinite(noPinAmount) || noPinAmount < 0 || noPinAmount > 2000) {
        return res.status(400).json({ success: false, message: 'Contactless limit must be between 0 and 2000.' });
      }
    }

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                        return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.cardType !== 'physical') return res.status(400).json({ success: false, message: 'Only physical cards can be activated.' });
    if (card.status === 'active')     return res.status(400).json({ success: false, message: 'This card is already active.' });
    if (card.status === 'cancelled')  return res.status(400).json({ success: false, message: 'Cancelled cards cannot be activated.' });
    if (!card.uqpayCardId)            return res.status(400).json({ success: false, message: 'Card provider reference not found. Please contact support.' });

    try {
      await UqpayService.resetCardPin(card.uqpayCardId, pin);
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Card activation failed. Please try again.' });
    }

    // Apply contactless limit if provided.
    // UQPay's update-card endpoint takes `no_pin_payment_amount` as a top-level number
    // (NOT nested inside spending_controls — that's only for amount/interval pairs).
    if (noPinAmount !== null) {
      try {
        await UqpayService.updateCard(card.uqpayCardId, {
          no_pin_payment_amount: noPinAmount,
        });
      } catch (e) {
        console.error('[activateCard] no_pin_amount update failed:', e.response?.data || e.message);
        // Not fatal — PIN is already set and card is activating
      }
    }

    // Sync live status from UQPay (typically becomes 'active' on its own)
    try {
      const info = await UqpayService.getCardInfo(card.uqpayCardId);
      const status = mapUqpayStatus(info.card_status || '');
      if (status !== card.status) {
        card.status = status;
        await card.save();
      }
    } catch (e) {
      console.error('[activateCard] UQPay status sync failed:', e.response?.data || e.message);
    }
    if (card.status !== 'active') {
      card.status = 'active';
      await card.save();
    }

    res.json({ success: true, message: 'Card activated successfully! Your card is now ready to use.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Update / Reset PIN ────────────────────────────────────────────────────

exports.updatePin = async (req, res) => {
  try {
    const { pin, pinConfirmation } = req.body;

    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'New PIN must be exactly 6 digits.' });
    }
    if (pin !== pinConfirmation) {
      return res.status(400).json({ success: false, message: 'PIN confirmation does not match.' });
    }
    if (isPinWeak(pin)) {
      return res.status(400).json({ success: false, message: 'PIN is too simple. Avoid repeated, ascending, or descending digits.' });
    }

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'PIN can only be updated on an active card.' });

    if (!card.uqpayCardId) {
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }
    try {
      await UqpayService.resetCardPin(card.uqpayCardId, pin);
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'PIN reset failed. Please try again.' });
    }

    res.json({ success: true, message: 'PIN updated successfully.' });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
