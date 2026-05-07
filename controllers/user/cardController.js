const crypto = require('crypto');
const axios = require('axios');
const Card = require('../../models/Card');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const CommissionSetting = require('../../models/CommissionSetting');
const UserCommissionSetting = require('../../models/UserCommissionSetting');
const CommissionLedger = require('../../models/CommissionLedger');
const PhysicalCardNumber = require('../../models/PhysicalCardNumber');
const AppSetting = require('../../models/AppSetting');

const wasabiApi = axios.create({
  baseURL: process.env.WASABI_API_URL,
  headers: { 'X-API-Key': process.env.WASABI_API_KEY },
});

function mapWasabiStatus(wasabiStatus) {
  const s = (wasabiStatus || '').toLowerCase();
  if (s === 'normal' || s === 'active') return 'active';
  if (s === 'freeze' || s === 'freezing' || s === 'frozen') return 'frozen';
  if (s === 'cancel' || s === 'canceling' || s === 'cancelled' || s === 'terminated') return 'cancelled';
  return s || 'processing';
}

async function getSettingNumber(key, fallback) {
  const setting = await AppSetting.findOne({ key });
  return setting ? (Number(setting.value) || fallback) : fallback;
}

// GET /user/cards
exports.listCards = async (req, res) => {
  try {
    const cards = await Card.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, cards });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/cards/:id
exports.getCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    res.json({ success: true, card });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/apply
exports.applyCard = async (req, res) => {
  try {
    const { cardType = 'virtual', organization = 'MasterCard', currency = 'USD', deliveryInfo } = req.body;

    if (req.user.kycStatus !== 'approved') return res.status(403).json({ success: false, message: 'KYC approval required' });

    const wallet = await Wallet.findOne({ userId: req.user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    // Commission — use type-specific setting (virtual vs physical)
    const issuanceType = cardType === 'physical' ? 'card_issuance_physical' : 'card_issuance_virtual';
    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: issuanceType });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: issuanceType });
    // fallback to generic card_issuance
    if (!commSetting) {
      commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'card_issuance' });
      if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'card_issuance' });
    }

    const defaultMin = cardType === 'physical'
      ? await getSettingNumber('physical_card_min_deposit', 50)
      : await getSettingNumber('virtual_card_min_deposit', 10);
    const depositAmount = Number(req.body.depositAmount) || defaultMin;
    let feeAmount = 0;
    if (commSetting) {
      feeAmount = commSetting.rateType === 'percentage' ? (depositAmount * commSetting.rate) / 100 : commSetting.rate;
    }
    const totalCharge = depositAmount + feeAmount;

    if (wallet.balance < totalCharge) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    // Ensure Wasabi holder exists — create if missing
    let holderId = cardType === 'virtual' ? req.user.wasabiHolderId : req.user.wasabiPhysicalHolderId;

    if (!holderId) {
      try {
        const holderRes = await wasabiApi.post('/holders', {
          email: req.user.email,
          name: req.user.name,
          mobile: req.user.mobile || req.user.phone || '',
        });
        holderId = holderRes.data.holderId;
        const holderField = cardType === 'physical' ? 'wasabiPhysicalHolderId' : 'wasabiHolderId';
        await User.findByIdAndUpdate(req.user._id, { [holderField]: holderId });
      } catch (holderErr) {
        return res.status(500).json({ success: false, message: 'Holder creation failed: ' + (holderErr.response?.data?.message || holderErr.message) });
      }
    }

    // Deduct wallet
    wallet.balance -= totalCharge;
    await wallet.save();

    const card = await Card.create({
      userId: req.user._id,
      wasabiHolderId: holderId,
      organization,
      currency,
      cardType,
      deliveryInfo: deliveryInfo || null,
      status: 'processing',
      depositAmount,
      feeAmount,
      holderEmail: req.user.email,
      holderMobile: req.user.mobile || req.user.phone || '',
    });

    // Call Wasabi to issue the card
    try {
      const wasabiRes = await wasabiApi.post('/cards', {
        holderId,
        cardType,
        currency,
        organization,
        deliveryInfo: deliveryInfo || undefined,
      });

      card.wasabiCardId = wasabiRes.data.cardId;
      card.cardNo = wasabiRes.data.maskedCardNumber;
      card.expireDate = wasabiRes.data.expireDate;
      card.status = mapWasabiStatus(wasabiRes.data.status) || 'active';
      await card.save();
    } catch (wasabiErr) {
      // Rollback: refund wallet, delete card record
      wallet.balance += totalCharge;
      await wallet.save();
      await Card.findByIdAndDelete(card._id);
      return res.status(500).json({ success: false, message: 'Card issuance failed: ' + (wasabiErr.response?.data?.message || wasabiErr.message) });
    }

    const txId = crypto.randomBytes(16).toString('hex');
    await WalletTransaction.create({
      userId: req.user._id,
      walletId: wallet._id,
      type: issuanceType,
      amount: totalCharge,
      status: 'completed',
      transactionId: txId,
    });

    if (commSetting && feeAmount > 0) {
      await CommissionLedger.create({
        userId: req.user._id,
        transactionId: txId,
        type: issuanceType,
        grossAmount: totalCharge,
        commissionAmount: feeAmount,
        netAmount: depositAmount,
        rateType: commSetting.rateType,
        rate: commSetting.rate,
      });
    }

    res.status(201).json({ success: true, message: 'Card issued successfully', card: { id: card._id, cardNo: card.cardNo, expireDate: card.expireDate, status: card.status } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/cards/:id/transactions
exports.cardTransactions = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card || !card.wasabiCardId) return res.status(404).json({ success: false, message: 'Card not found' });

    const { data } = await wasabiApi.get(`/cards/${card.wasabiCardId}/transactions`);
    res.json({ success: true, transactions: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/topup
exports.topupCard = async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Card is not active' });

    const wallet = await Wallet.findOne({ userId: req.user._id });

    // Commission — check user override, then global, then fallback to 1.5%
    let commSetting = await UserCommissionSetting.findOne({ userId: req.user._id, type: 'card_topup' });
    if (!commSetting) commSetting = await CommissionSetting.findOne({ type: 'card_topup' });

    let fee = commSetting
      ? (commSetting.rateType === 'percentage' ? (amount * commSetting.rate) / 100 : commSetting.rate)
      : (amount * 1.5) / 100; // PHP default: 1.5%

    const totalCharge = Number(amount) + fee;

    if (wallet.balance < totalCharge) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/load`, { amount });

    wallet.balance -= totalCharge;
    await wallet.save();

    card.balance += Number(amount);
    await card.save();

    const txId = crypto.randomBytes(16).toString('hex');
    await WalletTransaction.create({
      userId: req.user._id,
      walletId: wallet._id,
      type: 'card_topup',
      amount: totalCharge,
      status: 'completed',
      transactionId: txId,
    });

    if (fee > 0) {
      await CommissionLedger.create({
        userId: req.user._id,
        transactionId: txId,
        type: 'card_topup',
        grossAmount: totalCharge,
        commissionAmount: fee,
        netAmount: Number(amount),
        rateType: commSetting?.rateType || 'percentage',
        rate: commSetting?.rate || 1.5,
      });
    }

    res.json({ success: true, message: 'Card topped up', fee, newBalance: card.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/withdraw
exports.withdrawFromCard = async (req, res) => {
  try {
    const { amount } = req.body;
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Card is not active' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/unload`, { amount });

    const wallet = await Wallet.findOne({ userId: req.user._id });
    wallet.balance += Number(amount);
    await wallet.save();

    card.balance -= Number(amount);
    await card.save();

    const txId = crypto.randomBytes(16).toString('hex');
    await WalletTransaction.create({
      userId: req.user._id,
      walletId: wallet._id,
      type: 'card_withdraw',
      amount,
      status: 'completed',
      transactionId: txId,
    });

    res.json({ success: true, message: 'Funds moved to wallet', newBalance: card.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/freeze
exports.freezeCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/freeze`);
    card.status = 'frozen';
    await card.save();
    res.json({ success: true, message: 'Card frozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/unfreeze
exports.unfreezeCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/unfreeze`);
    card.status = 'active';
    await card.save();
    res.json({ success: true, message: 'Card unfrozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/terminate
exports.terminateCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/terminate`);
    card.status = 'cancelled';
    await card.save();
    res.json({ success: true, message: 'Card terminated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/reveal
exports.revealCard = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    const { data } = await wasabiApi.get(`/cards/${card.wasabiCardId}/reveal`);
    res.json({ success: true, cardDetails: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /user/cards/:id/balance
exports.refreshBalance = async (req, res) => {
  try {
    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });

    const { data } = await wasabiApi.get(`/cards/${card.wasabiCardId}/balance`);
    card.balance = data.balance || card.balance;
    await card.save();
    res.json({ success: true, balance: card.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/activate  (physical cards — set initial PIN)
exports.activateCard = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin)) return res.status(400).json({ success: false, message: 'PIN must be 4-6 digits' });
    const weak = ['0000', '1234', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '123456', '000000'];
    if (weak.includes(pin)) return res.status(400).json({ success: false, message: 'PIN is too weak' });

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.cardType !== 'physical') return res.status(400).json({ success: false, message: 'Only physical cards require activation' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/activate`, { pin });
    card.status = 'active';
    await card.save();
    res.json({ success: true, message: 'Card activated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /user/cards/:id/update-pin
exports.updatePin = async (req, res) => {
  try {
    const { currentPin, newPin } = req.body;
    if (!newPin || !/^\d{4,6}$/.test(newPin)) return res.status(400).json({ success: false, message: 'New PIN must be 4-6 digits' });
    const weak = ['0000', '1234', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '123456', '000000'];
    if (weak.includes(newPin)) return res.status(400).json({ success: false, message: 'New PIN is too weak' });

    const card = await Card.findOne({ _id: req.params.id, userId: req.user._id });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.status !== 'active') return res.status(400).json({ success: false, message: 'Card is not active' });

    await wasabiApi.post(`/cards/${card.wasabiCardId}/update-pin`, { currentPin, newPin });
    res.json({ success: true, message: 'PIN updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
