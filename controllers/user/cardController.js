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
const WasabiService = require('../../services/WasabiService');
const UqpayService = require('../../services/UqpayService');
const UqpayCardholder = require('../../models/UqpayCardholder');

function mapWasabiStatus(s) {
  s = (s || '').toLowerCase();
  if (s === 'normal' || s === 'active')                       return 'active';
  if (['freeze', 'freezing', 'unfreezing'].includes(s))       return 'frozen';
  if (['cancel', 'canceling', 'cancelled', 'terminated', 'fail'].includes(s)) return 'cancelled';
  if (s === 'processing' || s === 'failed')                   return s;
  return s || 'pending';
}

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

// ── Get Card (syncs balance/status from UQPay or Wasabi) ─────────────────

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
    } else if (card.wasabiCardId) {
      try {
        const wasabi = new WasabiService();
        const info   = await wasabi.getCardInfo(card.wasabiCardId);
        if (info) {
          const balance = parseFloat(info.balanceInfo?.amount ?? info.availableBalance ?? info.balance ?? card.balance);
          const status  = mapWasabiStatus(info.status || '');
          if (balance !== card.balance || status !== card.status) {
            card.balance = balance;
            card.status  = status;
            await card.save();
          }
        }
      } catch (e) {
        console.error('[getCard] Wasabi sync failed:', e.message);
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
      const firstName   = user.firstName || (user.name || '').split(' ')[0] || 'User';
      const lastName    = user.lastName  || (user.name || '').split(' ').slice(1).join(' ') || firstName;
      const countryCode = (user.country || 'US').trim().toUpperCase().slice(0, 2);
      const phoneNumber = user.mobile || user.phone || '0000000000';

      const chPayload = { email: user.email, first_name: firstName, last_name: lastName, country_code: countryCode, phone_number: phoneNumber };
      console.log('[UQPay] Creating cardholder:', chPayload);

      try {
        cardholder = await UqpayService.createCardholder({ ...chPayload, userId: user._id });
      } catch (chErr) {
        const errData = chErr.response?.data;
        console.error('[UQPay] Cardholder creation failed:', JSON.stringify(errData || chErr.message));
        const msg = errData?.message || errData?.error || errData?.msg || chErr.message;
        return res.status(422).json({ success: false, message: 'Cardholder creation failed: ' + msg });
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
      status            : 'processing',
      balance           : 0,
      depositAmount,
      feeAmount,
    });

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

    // ── PHASE 2: issue card on UQPay ──────────────────────────────────────
    let uqpayCard;
    try {
      uqpayCard = await UqpayService.createCard({
        card_currency,
        cardholder_id : cardholder.cardholder_id,
        card_product_id,
        cardholderId  : cardholder._id,
        userId        : user._id,
      });
    } catch (uqErr) {
      // Rollback wallet deduction
      wallet.balance = Math.round((wallet.balance + totalCharge) * 100) / 100;
      await wallet.save();
      await Card.findByIdAndUpdate(card._id, { status: 'failed' });
      const errData = uqErr.response?.data;
      console.error('[UQPay] Card creation failed:', JSON.stringify(errData || uqErr.message));
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

    const pageNum  = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;

    if (card.uqpayCardId) {
      try {
        const result = await UqpayService.getCardOrders(card.uqpayCardId, {
          page_size  : pageSize,
          page_number: pageNum,
        });
        const items = result.data || result.orders || result.items || result.records || [];
        const total = result.total_count || result.total || items.length;
        return res.json({
          success     : true,
          transactions: items.map(t => ({
            description: t.description || t.order_type || t.type || 'Transaction',
            amount     : t.amount      || t.transaction_amount || 0,
            date       : t.create_time || t.created_at || t.createdAt,
            type       : t.order_type  || t.type,
            status     : t.order_status || t.status,
          })),
          total,
          page    : pageNum,
          lastPage: Math.max(1, Math.ceil(total / pageSize)),
        });
      } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        return res.status(422).json({ success: false, message: msg });
      }
    }

    if (!card.wasabiCardId) return res.status(404).json({ success: false, message: 'Card provider reference not found' });

    const filters = { pageNum, pageSize };
    if (req.query.start) filters.startTime = req.query.start + ' 00:00:00';
    if (req.query.end)   filters.endTime   = req.query.end   + ' 23:59:59';

    const wasabi = new WasabiService();
    const result = await wasabi.getCardTransactions(card.wasabiCardId, filters);

    res.json({
      success     : true,
      transactions: result.records || [],
      total       : result.total   || 0,
      page        : pageNum,
      lastPage    : Math.max(1, Math.ceil((result.total || 0) / pageSize)),
    });
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
    } else if (card.wasabiCardId) {
      const wasabi = new WasabiService();
      const result = await wasabi.depositToCard(card.wasabiCardId, 'TOPUP-' + Date.now(), Number(amount));
      if (!result) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Top-up failed. Please try again.' });
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
    } else if (card.wasabiCardId) {
      const wasabi = new WasabiService();
      const result = await wasabi.withdrawFromCard(card.wasabiCardId, 'WDR-' + Date.now(), Number(amount));
      if (!result) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Withdraw failed. Please try again.' });
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
    } else if (card.wasabiCardId) {
      const wasabi = new WasabiService();
      const info   = await wasabi.getCardInfo(card.wasabiCardId);
      if (info) {
        card.balance = parseFloat(info.balanceInfo?.amount ?? info.availableBalance ?? info.balance ?? card.balance);
        card.status  = mapWasabiStatus(info.status || '');
        await card.save();
      }
    }

    res.json({ success: true, balance: card.balance, status: card.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Activate Physical Card ────────────────────────────────────────────────

exports.activateCard = async (req, res) => {
  try {
    const { pin, pinConfirmation, activeCode } = req.body;

    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be exactly 6 digits.' });
    }
    if (pin !== pinConfirmation) {
      return res.status(400).json({ success: false, message: 'PIN confirmation does not match.' });
    }
    if (isPinWeak(pin)) {
      return res.status(400).json({ success: false, message: 'PIN is too simple. Avoid repeated, ascending, or descending digits.' });
    }
    if (!activeCode || !activeCode.trim()) {
      return res.status(400).json({ success: false, message: 'Activation code is required.' });
    }

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card)                          return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.uqpayCardId)               return res.status(400).json({ success: false, message: 'UQPay cards are activated automatically. No manual activation required.' });
    if (card.cardType !== 'physical')   return res.status(400).json({ success: false, message: 'Only physical cards can be activated.' });
    if (card.status === 'active')       return res.status(400).json({ success: false, message: 'This card is already active.' });
    if (card.status === 'cancelled')    return res.status(400).json({ success: false, message: 'Cancelled cards cannot be activated.' });
    if (!card.wasabiCardId)             return res.status(400).json({ success: false, message: 'Card reference not found. Please contact support.' });

    const merchantOrderNo = 'ACT' + String(req.user._id).slice(-8).padStart(8, '0') + Date.now();
    const wasabi = new WasabiService();
    const result = await wasabi.activatePhysicalCard(card.wasabiCardId, merchantOrderNo, pin, activeCode.trim());

    if (!result) {
      return res.status(422).json({ success: false, message: 'Card activation failed: ' + (wasabi.lastError() || 'Please try again or contact support.') });
    }

    const apiStatus = (result.status || 'success').toLowerCase();
    if (['success', 'wait_process', 'processing'].includes(apiStatus)) {
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

    if (card.uqpayCardId) {
      try {
        await UqpayService.resetCardPin(card.uqpayCardId, pin);
      } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error || e.message;
        return res.status(422).json({ success: false, message: msg || 'PIN reset failed. Please try again.' });
      }
    } else if (card.wasabiCardId) {
      if (card.cardType !== 'physical') {
        return res.status(400).json({ success: false, message: 'PIN update is only for physical cards.' });
      }
      const merchantOrderNo = 'UPN' + String(req.user._id).slice(-8).padStart(8, '0') + Date.now();
      const wasabi = new WasabiService();
      const result = await wasabi.updatePhysicalCardPin(card.wasabiCardId, merchantOrderNo, pin);
      if (!result) {
        return res.status(422).json({ success: false, message: 'PIN update failed: ' + (wasabi.lastError() || 'Please try again or contact support.') });
      }
    } else {
      return res.status(422).json({ success: false, message: 'Card provider reference not found.' });
    }

    res.json({ success: true, message: 'PIN updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
