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

// ── Get Card (syncs balance/status from Wasabi) ───────────────────────────

exports.getCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    if (card.wasabiCardId) {
      const wasabi = new WasabiService();
      const info = await wasabi.getCardInfo(card.wasabiCardId);
      if (info) {
        const balance = parseFloat(info.balanceInfo?.amount ?? info.availableBalance ?? info.balance ?? card.balance);
        const status  = mapWasabiStatus(info.status || '');
        if (balance !== card.balance || status !== card.status) {
          card.balance = balance;
          card.status  = status;
          await card.save();
        }
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
      cardType     = 'virtual',
      card_type_id,
      holder_email,
      holder_mobile,
      depositAmount: depositAmt,
      deliveryInfo,
    } = req.body;

    if (!['virtual', 'physical'].includes(cardType)) {
      return res.status(400).json({ success: false, message: 'Invalid card type.' });
    }

    if (req.user.kycStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC approval required to apply for a card.' });
    }

    if (!holder_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holder_email)) {
      return res.status(400).json({ success: false, message: 'A valid cardholder email is required.' });
    }
    if (!holder_mobile) {
      return res.status(400).json({ success: false, message: 'Cardholder mobile number is required.' });
    }

    const emailTaken  = await Card.exists({ holderEmail: holder_email.trim(), status: { $ne: 'cancelled' } });
    if (emailTaken)  return res.status(400).json({ success: false, message: 'This email is already linked to another cardholder.' });

    const mobileTaken = await Card.exists({ holderMobile: holder_mobile.trim(), status: { $ne: 'cancelled' } });
    if (mobileTaken) return res.status(400).json({ success: false, message: 'This mobile number is already linked to another cardholder.' });

    if (cardType === 'physical') {
      const di = deliveryInfo || {};
      if (!di.name || !di.address || !di.city || !di.country || !di.postalCode || !di.phone) {
        return res.status(400).json({ success: false, message: 'Complete delivery info (name, address, city, country, postal code, phone) required for physical cards.' });
      }
    }

    const user = req.user;
    const missing = [];
    if (!user.gender)        missing.push('Gender');
    if (!user.birthday)      missing.push('Date of birth');
    if (!user.areaCode)      missing.push('Phone area code');
    if (!user.mobile)        missing.push('Mobile number');
    if (!user.town)          missing.push('City/Town');
    if (!user.address)       missing.push('Address');
    if (!user.postCode)      missing.push('Postal code');
    if (!user.country)       missing.push('Country');
    if (!user.kycDocType)    missing.push('ID type (re-submit KYC)');
    if (!user.kycIdNumber)   missing.push('ID number (re-submit KYC)');
    if (!user.kycIssueDate)  missing.push('ID issue date (re-submit KYC)');
    if (!user.kycExpiryDate) missing.push('ID expiry date (re-submit KYC)');
    if (!user.kycDocFront)   missing.push('ID front image (re-submit KYC)');
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: 'Missing required information: ' + missing.join(', ') });
    }

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

    // Physical card pool
    let assignedCardNumber = null;
    if (cardType === 'physical') {
      // Prefer pre-assigned → merchant pool → general pool
      assignedCardNumber = await PhysicalCardNumber.findOneAndUpdate(
        {
          isUsed: false,
          $or: [
            { preAssignedUserId: user._id },
            { merchantId: user.merchantId || null, preAssignedUserId: null },
            { merchantId: null, preAssignedUserId: null },
          ],
        },
        { $set: { isUsed: true, usedAt: new Date() } },
        { new: true, sort: { preAssignedUserId: -1 } }
      );
      if (!assignedCardNumber) {
        return res.status(400).json({ success: false, message: 'No physical card numbers available right now. Please contact support.' });
      }
    }

    const wasabi       = new WasabiService();
    const isPhysical   = cardType === 'physical';
    const holderColumn = isPhysical ? 'wasabiPhysicalHolderId' : 'wasabiHolderId';
    let   holderId     = isPhysical ? user.wasabiPhysicalHolderId : user.wasabiHolderId;
    const cardTypeId   = card_type_id ? Number(card_type_id)
      : isPhysical
        ? (Number(process.env.WASABI_PHYSICAL_CARD_TYPE_ID) || 2)
        : (Number(process.env.WASABI_VIRTUAL_CARD_TYPE_ID)  || 1);

    if (!holderId) {
      const idTypeMap  = { passport: 1, national_id: 2, driving_license: 3 };
      const idType     = idTypeMap[user.kycDocType] || 1;
      const orderPfx   = isPhysical ? 'HLDP' : 'HLD';
      const orderNo    = orderPfx + String(user._id).slice(-10).padStart(10, '0');
      const areaCode   = (user.areaCode || '').startsWith('+') ? user.areaCode : '+' + user.areaCode;
      const mobile     = (isPhysical && deliveryInfo?.phone)
        ? (deliveryInfo.phone + '').replace(/\D/g, '')
        : (user.mobile || '');

      const idFrontId = await wasabi.uploadKycFile(user.kycDocFront);
      if (!idFrontId) {
        if (assignedCardNumber) await PhysicalCardNumber.findByIdAndUpdate(assignedCardNumber._id, { $set: { isUsed: false, usedAt: null, cardId: null } });
        return res.status(500).json({ success: false, message: 'Failed to upload ID document. Please contact support.' });
      }
      const idBackId = user.kycDocBack ? await wasabi.uploadKycFile(user.kycDocBack) : null;
      const idHoldId = user.kycSelfie  ? await wasabi.uploadKycFile(user.kycSelfie)  : null;

      const payload = {
        cardHolderModel : 'B2C',
        cardTypeId,
        gender          : user.gender,
        idType,
        idNumber        : user.kycIdNumber,
        issueDate       : user.kycIssueDate  ? new Date(user.kycIssueDate).toISOString().split('T')[0]  : null,
        idNoExpiryDate  : user.kycExpiryDate ? new Date(user.kycExpiryDate).toISOString().split('T')[0] : null,
        idFrontId,
        ...(idBackId ? { idBackId } : {}),
        ...(idHoldId ? { idHoldId } : {}),
        nationality     : (user.country || '').toUpperCase(),
        merchantOrderNo : orderNo,
        firstName       : user.firstName || (user.name || '').split(' ')[0] || '',
        lastName        : user.lastName  || (user.name || '').split(' ').slice(1).join(' ') || '',
        email           : holder_email.trim(),
        areaCode,
        mobile,
        birthday        : user.birthday   ? new Date(user.birthday).toISOString().split('T')[0]   : null,
        country         : (user.country || '').toUpperCase(),
        town            : user.town,
        address         : (user.address || '').replace(/\s+/g, ' ').trim(),
        postCode        : user.postCode,
      };

      let holderResult = await wasabi.createHolder(payload);

      if (!holderResult) {
        // Retry with fresh orderNo (same as PHP)
        const freshOrderNo = orderPfx + String(user._id).slice(-8).padStart(8, '0') + 'R' + Date.now();
        payload.merchantOrderNo = freshOrderNo;
        holderResult = await wasabi.createHolder(payload);

        if (!holderResult) {
          if (assignedCardNumber) await PhysicalCardNumber.findByIdAndUpdate(assignedCardNumber._id, { $set: { isUsed: false, usedAt: null, cardId: null } });
          return res.status(500).json({ success: false, message: wasabi.lastError() || 'Failed to create cardholder. Please try again.' });
        }

        holderId = holderResult.holderId || holderResult.id || holderResult.cardHolderId || holderResult.holderNo;
        if (!holderId) holderId = await wasabi.findHolderByOrderNo(freshOrderNo);
      } else {
        holderId = holderResult.holderId || holderResult.id || holderResult.cardHolderId || holderResult.holderNo;
        if (!holderId) holderId = await wasabi.findHolderByOrderNo(orderNo);
        if (!holderId) holderId = await wasabi.findHolderByEmail(holder_email.trim(), cardTypeId);
      }

      if (!holderId) {
        if (assignedCardNumber) await PhysicalCardNumber.findByIdAndUpdate(assignedCardNumber._id, { $set: { isUsed: false, usedAt: null, cardId: null } });
        return res.status(500).json({ success: false, message: 'Cardholder exists on provider but ID could not be retrieved. Please contact support.' });
      }
      holderId = String(holderId);
      await User.findByIdAndUpdate(user._id, { [holderColumn]: holderId });
    }

    // PHASE 1 — deduct wallet + create card record (status=processing)
    const txnId = 'CARD-' + crypto.randomBytes(8).toString('hex').toUpperCase();

    wallet.balance = Math.round((wallet.balance - totalCharge) * 100) / 100;
    await wallet.save();

    const card = await Card.create({
      userId      : user._id,
      wasabiHolderId: holderId,
      wasabiCardId: null,
      cardNo      : assignedCardNumber ? assignedCardNumber.cardNumber : null,
      organization: 'MasterCard',
      currency    : 'USD',
      cardType,
      deliveryInfo: deliveryInfo || null,
      status      : 'processing',
      balance     : 0,
      expireDate  : null,
      depositAmount,
      feeAmount,
      merchantOrderNo: null,
      holderEmail : holder_email.trim(),
      holderMobile: holder_mobile.trim(),
    });

    if (assignedCardNumber) {
      await PhysicalCardNumber.findByIdAndUpdate(assignedCardNumber._id, { $set: { cardId: card._id } });
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

    // PHASE 2 — issue card on Wasabi
    const issueParams = {
      merchantOrderNo : 'MC-' + crypto.randomBytes(8).toString('hex'),
      holderId,
      cardTypeId,
      ...(cardType === 'physical' && assignedCardNumber ? { cardNumber: assignedCardNumber.cardNumber } : {}),
      ...(cardType === 'physical' && deliveryInfo       ? { deliveryAddress: deliveryInfo } : {}),
    };

    const issueResult = await wasabi.createCard(issueParams);

    if (!issueResult) {
      const err = (wasabi.lastError() || '').toLowerCase();
      if (err.includes('cardholder does not exist') || err.includes('cardholder verification failed')) {
        await User.findByIdAndUpdate(user._id, { [holderColumn]: null });
      }
      // Rollback
      wallet.balance = Math.round((wallet.balance + totalCharge) * 100) / 100;
      await wallet.save();
      await Card.findByIdAndUpdate(card._id, { status: 'failed' });
      if (assignedCardNumber) {
        await PhysicalCardNumber.findByIdAndUpdate(assignedCardNumber._id, { $set: { isUsed: false, cardId: null, usedAt: null } });
      }
      const msg = wasabi.lastError() || 'Card issuance failed. Please try again.';
      return res.status(422).json({ success: false, message: msg });
    }

    const wasabiCardId = issueResult.cardNo || issueResult.cardId || issueResult.id || null;
    await Card.findByIdAndUpdate(card._id, { wasabiCardId: wasabiCardId ? String(wasabiCardId) : null, status: 'pending', expireDate: issueResult.expireDate || null });

    res.status(201).json({
      success : true,
      message : `${cardType} card issued successfully! $${totalCharge.toFixed(2)} deducted from wallet.`,
      cardId  : card._id,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Transactions (paginated, date-filtered) ───────────────────────────────

exports.cardTransactions = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card || !card.wasabiCardId) return res.status(404).json({ success: false, message: 'Card not found' });

    const pageNum  = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;
    const filters  = { pageNum, pageSize };
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

    const feeRate    = commSetting?.rateType === 'percentage' ? commSetting.rate : 1.5;
    const fee        = Math.round(Number(amount) * feeRate / 100 * 100) / 100;
    const totalCharge = Math.round((Number(amount) + fee) * 100) / 100;

    if (wallet.balance < totalCharge) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Need $${totalCharge.toFixed(2)} (top-up $${Number(amount).toFixed(2)} + ${feeRate}% fee $${fee.toFixed(2)}). Your balance: $${Number(wallet.balance).toFixed(2)}.`,
      });
    }

    const wasabi = new WasabiService();
    const result = await wasabi.depositToCard(card.wasabiCardId, 'TOPUP-' + Date.now(), Number(amount));
    if (!result) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Top-up failed. Please try again.' });

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

    const wasabi = new WasabiService();
    const result = await wasabi.withdrawFromCard(card.wasabiCardId, 'WDR-' + Date.now(), Number(amount));
    if (!result) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Withdraw failed. Please try again.' });

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

    const wasabi = new WasabiService();
    const result = await wasabi.freezeCard(card.wasabiCardId);
    if (result === null) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Failed to freeze card. Please try again.' });

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

    const wasabi = new WasabiService();
    const result = await wasabi.unfreezeCard(card.wasabiCardId);
    if (result === null) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Failed to unfreeze card. Please try again.' });

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
    if (!card)                      return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status === 'cancelled') return res.status(400).json({ success: false, message: 'Card is already terminated.' });

    const wasabi = new WasabiService();
    const result = await wasabi.cancelCard(card.wasabiCardId);
    if (result === null) {
      const err = wasabi.lastError() || '';
      const msg = err.toLowerCase().includes('not support')
        ? 'This card product does not support termination via API. Please contact support to cancel this card.'
        : (err || 'Failed to terminate card. Please try again.');
      return res.status(422).json({ success: false, message: msg });
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
    if (!['active', 'frozen'].includes(card.status)) {
      return res.status(422).json({ success: false, message: 'Card is not active.' });
    }
    if (!card.wasabiCardId) return res.status(422).json({ success: false, message: 'Card reference not found.' });

    const wasabi = new WasabiService();
    const info = await wasabi.getSensitiveInfo(card.wasabiCardId);
    if (!info) return res.status(422).json({ success: false, message: wasabi.lastError() || 'Failed to reveal card info.' });

    res.json({
      success    : true,
      cardDetails: {
        cardNumber : info.cardNumber || '',
        cvv        : info.cvv        || '',
        expireDate : info.expireDate  || '',
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
    if (!card.wasabiCardId) return res.json({ success: true, balance: card.balance, status: card.status });

    const wasabi = new WasabiService();
    const info = await wasabi.getCardInfo(card.wasabiCardId);
    if (info) {
      card.balance = parseFloat(info.balanceInfo?.amount ?? info.availableBalance ?? info.balance ?? card.balance);
      card.status  = mapWasabiStatus(info.status || '');
      await card.save();
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

// ── Update Physical Card PIN ──────────────────────────────────────────────

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
    if (!card)                        return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.cardType !== 'physical') return res.status(400).json({ success: false, message: 'PIN update is only for physical cards.' });
    if (card.status !== 'active')     return res.status(400).json({ success: false, message: 'PIN can only be updated on an active card.' });
    if (!card.wasabiCardId)           return res.status(400).json({ success: false, message: 'Card reference not found.' });

    const merchantOrderNo = 'UPN' + String(req.user._id).slice(-8).padStart(8, '0') + Date.now();
    const wasabi = new WasabiService();
    const result = await wasabi.updatePhysicalCardPin(card.wasabiCardId, merchantOrderNo, pin);

    if (!result) {
      return res.status(422).json({ success: false, message: 'PIN update failed: ' + (wasabi.lastError() || 'Please try again or contact support.') });
    }

    res.json({ success: true, message: 'PIN updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
