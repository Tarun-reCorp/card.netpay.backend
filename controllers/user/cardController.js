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

async function getCommission(userId, type) {
  let s = await UserCommissionSetting.findOne({ userId, type });
  if (!s) s = await CommissionSetting.findOne({ type });
  return s;
}

// ── UQPay Products (for card application form) ────────────────────────────

exports.getProducts = async (req, res) => {
  try {
    const data = await UqpayService.getProducts({ page_size: 50 });
    const products = data.data || data.products || data.items || [];
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

      let fee = 0, feePct = 0;
      if (commSetting) {
        if (commSetting.rateType === 'percentage') {
          feePct = commSetting.rate;
          fee = Math.round(minDeposit * commSetting.rate / 100 * 100) / 100;
        } else {
          fee = commSetting.rate;
        }
      }
      return { min_deposit: minDeposit, fee_pct: feePct, issuance_fee: fee, total: Math.round((minDeposit + fee) * 100) / 100 };
    };

    const [virtual, physical] = await Promise.all([
      calc('card_issuance_virtual', 10),
      calc('card_issuance_physical', 50),
    ]);

    res.json({ success: true, virtual, physical });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── List Cards ────────────────────────────────────────────────────────────

exports.listCards = async (req, res) => {
  try {
    const cards = await Card.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, cards });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    } = req.body;

    if (!['virtual', 'physical'].includes(cardType)) {
      return res.status(400).json({ success: false, message: 'Invalid card type.' });
    }

    if (req.user.kycStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC approval required to apply for a card.' });
    }

    if (!card_product_id) {
      return res.status(400).json({ success: false, message: 'Please select a card product.' });
    }

    const user   = req.user;
    const wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    const issuanceType = cardType === 'physical' ? 'card_issuance_physical' : 'card_issuance_virtual';
    let commSetting = await getCommission(user._id, issuanceType);
    if (!commSetting) commSetting = await getCommission(user._id, 'card_issuance');

    const defaultMin    = cardType === 'physical'
      ? await getSettingNumber('physical_card_min_deposit', 50)
      : await getSettingNumber('virtual_card_min_deposit', 10);
    const depositAmount = Number(depositAmt) || defaultMin;

    let feeAmount = 0;
    if (commSetting) {
      feeAmount = commSetting.rateType === 'percentage'
        ? Math.round(depositAmount * commSetting.rate / 100 * 100) / 100
        : commSetting.rate;
    }
    const totalCharge = Math.round((depositAmount + feeAmount) * 100) / 100;

    if (wallet.balance < totalCharge) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Need $${totalCharge.toFixed(2)} but wallet has $${Number(wallet.balance).toFixed(2)}.`,
      });
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
      const genderMap = { male: 'MALE', female: 'FEMALE', other: 'OTHER', m: 'MALE', f: 'FEMALE' };
      const g = (user.gender || '').toString().trim().toLowerCase();
      if (genderMap[g]) cardholderPayload.gender = genderMap[g];

      const docTypeMap = {
        passport: 'PASSPORT',
        national_id: 'ID_CARD', id_card: 'ID_CARD', nid: 'ID_CARD',
        driving_license: 'DRIVER_LICENSE', drivers_license: 'DRIVER_LICENSE',
        driver_license: 'DRIVER_LICENSE', dl: 'DRIVER_LICENSE',
      };
      const dt = (user.kycDocType || '').toString().trim().toLowerCase();
      if (docTypeMap[dt] && user.kycIdNumber) {
        cardholderPayload.document_type = docTypeMap[dt];
        cardholderPayload.document      = String(user.kycIdNumber).trim();
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

    // ── PHASE 1: deduct wallet + create local Card record ─────────────────
    const txnId = 'CARD-' + crypto.randomBytes(8).toString('hex').toUpperCase();

    wallet.balance = Math.round((wallet.balance - totalCharge) * 100) / 100;
    await wallet.save();

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
    });

    if (physCard) {
      await PhysicalCardNumber.findByIdAndUpdate(physCard._id, { cardId: card._id });
    }

    await WalletTransaction.create({
      userId        : user._id,
      walletId      : wallet._id,
      type          : 'card_issuance',
      amount        : totalCharge,
      status        : 'completed',
      transactionId : txnId,
    });

    if (commSetting && feeAmount > 0) {
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
      // Rollback wallet deduction
      wallet.balance = Math.round((wallet.balance + totalCharge) * 100) / 100;
      await wallet.save();
      await Card.findByIdAndUpdate(card._id, { status: 'failed' });
      // Release reserved physical card number back to inventory
      if (physCard) await releasePhysicalCardNumber(physCard._id);
      const errData = uqErr.response?.data;
      console.error('[UQPay] Card issuance failed:', JSON.stringify(errData || uqErr.message));
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

      const items = result.data || result.orders || result.items || result.records || result.list || [];
      const total = result.total_count || result.total || items.length;

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
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Top-up (Load) ─────────────────────────────────────────────────────────

exports.topupCard = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Top-up is only available for active cards.' });

    const wallet = await Wallet.findOne({ userId: req.user._id });

    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'card_topup' });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'card_topup' });

    const feeRate     = commSetting?.rateType === 'percentage' ? commSetting.rate : 1.5;
    const fee         = Math.round(Number(amount) * feeRate / 100 * 100) / 100;
    const totalCharge = Math.round((Number(amount) + fee) * 100) / 100;

    if (wallet.balance < totalCharge) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Need $${totalCharge.toFixed(2)} (top-up $${Number(amount).toFixed(2)} + ${feeRate}% fee $${fee.toFixed(2)}). Your balance: $${Number(wallet.balance).toFixed(2)}.`,
      });
    }

    // Call card provider
    if (card.uqpayCardId) {
      try {
        await UqpayService.rechargeCard(card.uqpayCardId, Number(amount));
      } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        return res.status(422).json({ success: false, message: msg || 'Top-up failed. Please try again.' });
      }
    } else {
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    wallet.balance = Math.round((wallet.balance - totalCharge) * 100) / 100;
    await wallet.save();
    card.balance = Math.round((card.balance + Number(amount)) * 100) / 100;
    await card.save();

    const txnId = 'TOPUP-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    await WalletTransaction.create({
      userId: req.user._id, walletId: wallet._id,
      type: 'card_topup', amount: totalCharge, status: 'completed', transactionId: txnId,
    });

    if (fee > 0) {
      await CommissionLedger.create({
        userId: req.user._id, transactionId: txnId, type: 'card_topup',
        grossAmount: totalCharge, commissionAmount: fee, netAmount: Number(amount),
        rateType: commSetting?.rateType || 'percentage', rate: feeRate,
      });
    }

    res.json({ success: true, message: `Top-up of $${Number(amount).toFixed(2)} successful.`, fee, newBalance: card.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Withdraw from Card ────────────────────────────────────────────────────

exports.withdrawFromCard = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Withdraw is only available for active cards.' });

    // Call card provider
    if (card.uqpayCardId) {
      try {
        await UqpayService.withdrawCard(card.uqpayCardId, Number(amount));
      } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        return res.status(422).json({ success: false, message: msg || 'Withdraw failed. Please try again.' });
      }
    } else {
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    const wallet = await Wallet.findOne({ userId: req.user._id });
    wallet.balance = Math.round((wallet.balance + Number(amount)) * 100) / 100;
    await wallet.save();
    card.balance = Math.round((card.balance - Number(amount)) * 100) / 100;
    await card.save();

    await WalletTransaction.create({
      userId: req.user._id, walletId: wallet._id,
      type: 'card_withdraw', amount: Number(amount), status: 'completed',
      transactionId: 'WDR-' + crypto.randomBytes(8).toString('hex').toUpperCase(),
    });

    res.json({ success: true, message: `$${Number(amount).toFixed(2)} withdrawn from card to wallet.`, newBalance: card.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Freeze ────────────────────────────────────────────────────────────────

exports.freezeCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Only active cards can be frozen.' });
    if (!card.uqpayCardId)        return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'FROZEN', 'User requested freeze');
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to freeze card. Please try again.' });
    }

    card.status = 'frozen';
    await card.save();
    res.json({ success: true, message: 'Card has been frozen successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Unfreeze ──────────────────────────────────────────────────────────────

exports.unfreezeCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                    return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'frozen') return res.status(400).json({ success: false, message: 'Only frozen cards can be unfrozen.' });
    if (!card.uqpayCardId)        return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'ACTIVE', 'User requested unfreeze');
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to unfreeze card. Please try again.' });
    }

    card.status = 'active';
    await card.save();
    res.json({ success: true, message: 'Card has been unfrozen successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Terminate ─────────────────────────────────────────────────────────────

exports.terminateCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                       return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status === 'cancelled') return res.status(400).json({ success: false, message: 'Card is already terminated.' });
    if (!card.uqpayCardId)           return res.status(422).json({ success: false, message: 'Card provider reference not found.' });

    try {
      await UqpayService.updateCardStatus(card.uqpayCardId, 'CANCELLED', 'User requested termination');
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.data?.error || e.message;
      return res.status(422).json({ success: false, message: msg || 'Failed to terminate card. Please try again.' });
    }

    card.status = 'cancelled';
    await card.save();
    res.json({ success: true, message: 'Card has been permanently terminated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
      console.log('[revealCard] UQPay secure response:', JSON.stringify(info));
    } catch (e) {
      console.error('[revealCard] UQPay secure error:', JSON.stringify(e.response?.data || e.message));
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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

    // Apply contactless limit if provided
    if (noPinAmount !== null) {
      try {
        await UqpayService.updateCard(card.uqpayCardId, {
          spending_controls: {
            no_pin_payment_amount: [{ amount: String(noPinAmount), currency: card.currency || 'USD' }],
          },
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
};
