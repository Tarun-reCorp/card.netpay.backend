// Public REST API for merchants to manage cards programmatically (via UQPay).
// All routes are protected by X-API-Key in apiKeyMiddleware.
const User             = require('../../models/User');
const Card             = require('../../models/Card');
const UqpayCardholder  = require('../../models/UqpayCardholder');
const UqpayService     = require('../../services/UqpayService');

function errMsg(err, fallback = 'Provider error') {
  const d = err.response?.data;
  return d?.message || d?.error || d?.msg || err.message || fallback;
}

// GET /api/health
exports.health = (req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date() });
};

// POST /api/cards/holder
// Creates a UQPay cardholder for the given user (or returns the existing one).
exports.createHolder = async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let cardholder = await UqpayCardholder.findOne({ userId: user._id });
    if (cardholder) {
      return res.json({ success: true, holderId: cardholder.cardholder_id, existed: true });
    }

    const countryCode = (user.country || '').trim().toUpperCase();
    const phoneNumber = (user.mobile || '').replace(/\D/g, '');
    if (!countryCode || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'User profile is missing country (ISO-2) or mobile number.' });
    }

    cardholder = await UqpayService.createCardholder({
      userId      : user._id,
      email       : user.email,
      first_name  : user.firstName || (user.name || '').split(' ')[0] || 'User',
      last_name   : user.lastName  || (user.name || '').split(' ').slice(1).join(' ') || 'User',
      country_code: countryCode,
      phone_number: phoneNumber,
    });

    res.json({ success: true, holderId: cardholder.cardholder_id });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/issue
// Issues a virtual card (createCard) or assigns a pre-issued physical card (assignCard).
// Body: { userId, cardType ('virtual'|'physical'), card_product_id, card_currency,
//         card_mode ('SINGLE'|'SHARE', physical only), card_number (physical only) }
exports.issueCard = async (req, res) => {
  try {
    const {
      userId, cardType = 'virtual', card_product_id,
      card_currency = 'USD', card_mode = 'SINGLE', card_number,
    } = req.body;

    if (!['virtual', 'physical'].includes(cardType)) {
      return res.status(400).json({ success: false, message: 'cardType must be virtual or physical' });
    }
    if (!card_product_id) {
      return res.status(400).json({ success: false, message: 'card_product_id is required' });
    }
    if (cardType === 'physical' && !card_number) {
      return res.status(400).json({ success: false, message: 'card_number is required for physical cards' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let cardholder = await UqpayCardholder.findOne({ userId: user._id });
    if (!cardholder) {
      return res.status(400).json({ success: false, message: 'Cardholder not created. Call /api/cards/holder first.' });
    }

    let uqpayCard;
    try {
      if (cardType === 'physical') {
        uqpayCard = await UqpayService.assignCard({
          cardholder_id : cardholder.cardholder_id,
          card_number,
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
    } catch (e) {
      return res.status(422).json({ success: false, message: errMsg(e, 'Card issuance failed') });
    }

    const card = await Card.create({
      userId            : user._id,
      uqpayCardholderId : cardholder.cardholder_id,
      uqpayCardId       : uqpayCard.card_id,
      currency          : card_currency,
      cardType,
      cardNo            : cardType === 'physical' ? card_number : null,
      status            : 'pending',
      balance           : 0,
    });

    res.json({ success: true, cardId: card._id, uqpayCardId: uqpayCard.card_id });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// GET /api/cards/:cardId/balance
exports.getBalance = async (req, res) => {
  try {
    const info = await UqpayService.getCardInfo(req.params.cardId);
    res.json({
      success: true,
      balance: parseFloat(info.balance ?? info.available_balance ?? 0),
      status : info.card_status,
      raw    : info,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// GET /api/cards/holder/:holderId
// Lists cards stored locally for the given UQPay cardholder.
exports.listCards = async (req, res) => {
  try {
    const cardholder = await UqpayCardholder.findOne({ cardholder_id: req.params.holderId });
    if (!cardholder) return res.status(404).json({ success: false, message: 'Cardholder not found' });
    const cards = await Card.find({ uqpayCardholderId: cardholder.cardholder_id }).sort({ createdAt: -1 });
    res.json({ success: true, cards });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// GET /api/cards/:cardId/transactions?page=1&limit=20
exports.getTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, start, end } = req.query;
    const params = { page_size: Number(limit), page_number: Number(page) };
    if (start) params.start_time = start;
    if (end)   params.end_time   = end;
    const data = await UqpayService.getCardOrders(req.params.cardId, params);
    res.json({ success: true, transactions: data.records || data.list || data, total: data.total || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/:cardId/load   body: { amount }
exports.loadCard = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }
    const data = await UqpayService.rechargeCard(req.params.cardId, amount);
    res.json({ success: true, result: data });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/:cardId/unload   body: { amount }
exports.unloadCard = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }
    const data = await UqpayService.withdrawCard(req.params.cardId, amount);
    res.json({ success: true, result: data });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/:cardId/freeze
exports.freezeCard = async (req, res) => {
  try {
    await UqpayService.updateCardStatus(req.params.cardId, 'FROZEN', req.body?.reason);
    await Card.findOneAndUpdate({ uqpayCardId: req.params.cardId }, { status: 'frozen' });
    res.json({ success: true, message: 'Card frozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/:cardId/unfreeze
exports.unfreezeCard = async (req, res) => {
  try {
    await UqpayService.updateCardStatus(req.params.cardId, 'ACTIVE', req.body?.reason);
    await Card.findOneAndUpdate({ uqpayCardId: req.params.cardId }, { status: 'active' });
    res.json({ success: true, message: 'Card unfrozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// POST /api/cards/:cardId/terminate
exports.terminateCard = async (req, res) => {
  try {
    await UqpayService.updateCardStatus(req.params.cardId, 'CANCELLED', req.body?.reason || 'Terminated via API');
    await Card.findOneAndUpdate({ uqpayCardId: req.params.cardId }, { status: 'cancelled' });
    res.json({ success: true, message: 'Card terminated' });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};

// GET /api/cards/:cardId/reveal — returns decrypted PAN/CVV/expiry
exports.revealCard = async (req, res) => {
  try {
    const data = await UqpayService.getCardSensitiveInfo(req.params.cardId);
    res.json({ success: true, cardDetails: data });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
};
