const axios = require('axios');
const User = require('../../models/User');
const Card = require('../../models/Card');

const wasabiApi = axios.create({
  baseURL: process.env.WASABI_API_URL,
  headers: { 'X-API-Key': process.env.WASABI_API_KEY },
});

// GET /api/health
exports.health = (req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date() });
};

// POST /api/cards/holder
exports.createHolder = async (req, res) => {
  try {
    const { userId, holderType = 'virtual' } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { data } = await wasabiApi.post('/holders', {
      email: user.email,
      name: user.name,
      mobile: user.mobile,
    });

    const field = holderType === 'physical' ? 'wasabiPhysicalHolderId' : 'wasabiHolderId';
    await User.findByIdAndUpdate(userId, { [field]: data.holderId });

    res.json({ success: true, holderId: data.holderId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/issue
exports.issueCard = async (req, res) => {
  try {
    const { userId, cardType = 'virtual', holderId, currency = 'USD', organization = 'MasterCard', deliveryInfo } = req.body;

    const { data } = await wasabiApi.post('/cards', {
      holderId,
      cardType,
      currency,
      organization,
      deliveryInfo,
    });

    const card = await Card.findOneAndUpdate(
      { userId, status: 'processing', cardType },
      {
        wasabiCardId: data.cardId,
        wasabiHolderId: holderId,
        cardNo: data.maskedCardNumber,
        expireDate: data.expireDate,
        status: 'active',
      },
      { new: true }
    );

    res.json({ success: true, card });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/cards/:wasabiCardId/balance
exports.getBalance = async (req, res) => {
  try {
    const { data } = await wasabiApi.get(`/cards/${req.params.wasabiCardId}/balance`);
    res.json({ success: true, balance: data.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/cards/holder/:holderId
exports.listCards = async (req, res) => {
  try {
    const { data } = await wasabiApi.get(`/holders/${req.params.holderId}/cards`);
    res.json({ success: true, cards: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/cards/:wasabiCardId/transactions
exports.getTransactions = async (req, res) => {
  try {
    const { data } = await wasabiApi.get(`/cards/${req.params.wasabiCardId}/transactions`);
    res.json({ success: true, transactions: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/:wasabiCardId/load
exports.loadCard = async (req, res) => {
  try {
    const { amount } = req.body;
    const { data } = await wasabiApi.post(`/cards/${req.params.wasabiCardId}/load`, { amount });
    res.json({ success: true, result: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/:wasabiCardId/unload
exports.unloadCard = async (req, res) => {
  try {
    const { amount } = req.body;
    const { data } = await wasabiApi.post(`/cards/${req.params.wasabiCardId}/unload`, { amount });
    res.json({ success: true, result: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/:wasabiCardId/freeze
exports.freezeCard = async (req, res) => {
  try {
    await wasabiApi.post(`/cards/${req.params.wasabiCardId}/freeze`);
    await Card.findOneAndUpdate({ wasabiCardId: req.params.wasabiCardId }, { status: 'frozen' });
    res.json({ success: true, message: 'Card frozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/:wasabiCardId/unfreeze
exports.unfreezeCard = async (req, res) => {
  try {
    await wasabiApi.post(`/cards/${req.params.wasabiCardId}/unfreeze`);
    await Card.findOneAndUpdate({ wasabiCardId: req.params.wasabiCardId }, { status: 'active' });
    res.json({ success: true, message: 'Card unfrozen' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cards/:wasabiCardId/terminate
exports.terminateCard = async (req, res) => {
  try {
    await wasabiApi.post(`/cards/${req.params.wasabiCardId}/terminate`);
    await Card.findOneAndUpdate({ wasabiCardId: req.params.wasabiCardId }, { status: 'cancelled' });
    res.json({ success: true, message: 'Card terminated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/cards/:wasabiCardId/reveal
exports.revealCard = async (req, res) => {
  try {
    const { data } = await wasabiApi.get(`/cards/${req.params.wasabiCardId}/reveal`);
    res.json({ success: true, cardDetails: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
