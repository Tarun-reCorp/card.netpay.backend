const UqpayService    = require('../../services/UqpayService');
const UqpayCardholder = require('../../models/UqpayCardholder');
const UqpayCard       = require('../../models/UqpayCard');
const Card            = require('../../models/Card');
const User            = require('../../models/User');

// ── Cardholders ───────────────────────────────────────────────────────────────

// POST /admin/uqpay/cardholders
exports.createCardholder = async (req, res) => {
  try {
    const { email, first_name, last_name, country_code, phone_number, date_of_birth, gender, nationality, document_type, document, userId } = req.body;

    if (!email || !first_name || !last_name || !country_code || !phone_number) {
      return res.status(400).json({
        success: false,
        message: 'email, first_name, last_name, country_code, phone_number are required',
      });
    }

    const cardholder = await UqpayService.createCardholder({
      email, first_name, last_name, country_code, phone_number,
      date_of_birth, gender, nationality, document_type, document,
      userId: userId || null,
      adminId: req.admin._id,
    });

    res.json({ success: true, cardholder });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// GET /admin/uqpay/cardholders
exports.listCardholders = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;

    const filter = {};
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [
        { email: re }, { first_name: re }, { last_name: re },
        { cardholder_id: re }, { phone_number: re },
      ];
    }
    if (status) filter.cardholder_status = new RegExp(`^${status}$`, 'i');

    const [cardholders, total, totalAll, userLinked, adminCreated] = await Promise.all([
      UqpayCardholder.find(filter)
        .populate('userId', 'name email')
        .populate('adminId', 'name email')
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit)),
      UqpayCardholder.countDocuments(filter),
      UqpayCardholder.countDocuments({}),
      UqpayCardholder.countDocuments({ userId: { $ne: null } }),
      UqpayCardholder.countDocuments({ adminId: { $ne: null }, userId: null }),
    ]);

    res.json({
      success: true,
      cardholders,
      total,
      stats: {
        total: totalAll,
        userLinked,
        adminCreated,
        unlinked: totalAll - userLinked - adminCreated,
      },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/uqpay/cardholders/uqpay-list  — live list from UQPay
exports.listCardholdersUQPay = async (req, res) => {
  try {
    const { page_size = 20, page_number = 1 } = req.query;
    const data = await UqpayService.listCardholdersFromUQPay({ page_size: Number(page_size), page_number: Number(page_number) });
    res.json({ success: true, ...data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// GET /admin/uqpay/cardholders/:id  — retrieve single from UQPay + sync DB
exports.getCardholder = async (req, res) => {
  try {
    const data = await UqpayService.getCardholder(req.params.id);
    if (data.cardholder_status) {
      await UqpayCardholder.findOneAndUpdate(
        { cardholder_id: req.params.id },
        { cardholder_status: data.cardholder_status }
      );
    }
    res.json({ success: true, cardholder: data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// POST /admin/uqpay/cardholders/:id  — update cardholder on UQPay + sync DB
exports.updateCardholder = async (req, res) => {
  try {
    const { id } = req.params;
    const { country_code, email, phone_number, date_of_birth, gender, nationality, document_type, document } = req.body;

    const data = await UqpayService.updateCardholder(id, { country_code, email, phone_number, date_of_birth, gender, nationality, document_type, document });

    const dbUpdate = {};
    if (country_code)           dbUpdate.country_code      = country_code;
    if (email)                  dbUpdate.email             = email;
    if (phone_number)           dbUpdate.phone_number      = phone_number;
    if (date_of_birth)          dbUpdate.date_of_birth     = date_of_birth;
    if (gender)                 dbUpdate.gender            = gender;
    if (nationality)            dbUpdate.nationality       = nationality;
    if (document_type)          dbUpdate.document_type     = document_type;
    if (data.cardholder_status) dbUpdate.cardholder_status = data.cardholder_status;

    await UqpayCardholder.findOneAndUpdate({ cardholder_id: id }, { $set: dbUpdate });

    res.json({ success: true, message: 'Cardholder updated successfully', data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// ── Products ──────────────────────────────────────────────────────────────────

// GET /admin/uqpay/products
exports.listProducts = async (req, res) => {
  try {
    const { page_size = 10, page_number = 1 } = req.query;
    const data = await UqpayService.getProducts({ page_size: Number(page_size), page_number: Number(page_number) });
    res.json({ success: true, ...data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// ── Cards ─────────────────────────────────────────────────────────────────────

// GET /admin/uqpay/cards/stats
exports.getCardStats = async (req, res) => {
  try {
    const base = { uqpayCardId: { $ne: null } };

    const [total, active, frozen, cancelled, pending, virtual_, physical, balResult] = await Promise.all([
      Card.countDocuments(base),
      Card.countDocuments({ ...base, status: 'active' }),
      Card.countDocuments({ ...base, status: 'frozen' }),
      Card.countDocuments({ ...base, status: 'cancelled' }),
      Card.countDocuments({ ...base, status: 'pending' }),
      Card.countDocuments({ ...base, cardType: 'virtual' }),
      Card.countDocuments({ ...base, cardType: 'physical' }),
      Card.aggregate([
        { $match: { uqpayCardId: { $ne: null }, status: 'active' } },
        { $group: { _id: null, total: { $sum: '$balance' } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        total, active, frozen, cancelled, pending,
        virtual: virtual_, physical,
        totalBalance: balResult[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /admin/uqpay/cards  — DB list (Card model, UQPay cards only)
exports.listCards = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, type } = req.query;

    const filter = { uqpayCardId: { $ne: null } };
    if (status) filter.status   = status;
    if (type)   filter.cardType = type;

    if (search) {
      const re      = new RegExp(search, 'i');
      const users   = await User.find({ $or: [{ email: re }, { name: re }] }).select('_id').lean();
      const userIds = users.map(u => u._id);
      filter.$or    = [
        { uqpayCardId: re },
        { uqpayCardholderId: re },
        { userId: { $in: userIds } },
      ];
    }

    const [cards, total] = await Promise.all([
      Card.find(filter)
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit)),
      Card.countDocuments(filter),
    ]);

    res.json({ success: true, cards, total });
  } catch (err) {
    console.error('[500]', req.originalUrl, err); res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /admin/uqpay/cards
exports.createCard = async (req, res) => {
  try {
    const { cardholder_id, card_product_id, card_currency = 'USD', cardholderId, userId } = req.body;

    if (!cardholder_id || !card_product_id) {
      return res.status(400).json({
        success: false,
        message: 'cardholder_id and card_product_id are required',
      });
    }

    const card = await UqpayService.createCard({
      card_currency,
      cardholder_id,
      card_product_id,
      cardholderId: cardholderId || null,
      userId: userId || null,
      adminId: req.admin._id,
    });

    res.json({ success: true, card });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// GET /admin/uqpay/cards/uqpay-list  — live list from UQPay
exports.listCardsUQPay = async (req, res) => {
  try {
    const { page_size = 20, page_number = 1 } = req.query;
    const data = await UqpayService.listCardsFromUQPay({ page_size: Number(page_size), page_number: Number(page_number) });
    res.json({ success: true, ...data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// GET /admin/uqpay/cards/:id  — retrieve single card from UQPay + sync DB
exports.getUqpayCard = async (req, res) => {
  try {
    const data = await UqpayService.getCardInfo(req.params.id);
    if (data.card_status) {
      await UqpayCard.findOneAndUpdate(
        { card_id: req.params.id },
        { card_status: data.card_status, order_status: data.order_status }
      );
    }
    res.json({ success: true, card: data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};

// POST /admin/uqpay/cards/:id  — update card on UQPay
exports.updateCard = async (req, res) => {
  try {
    const { id } = req.params;
    const { card_limit, name_on_card, no_pin_payment_amount, spending_controls, risk_controls, metadata } = req.body;

    const payload = {};
    if (card_limit !== undefined)            payload.card_limit            = card_limit;
    if (name_on_card)                        payload.name_on_card          = name_on_card;
    if (no_pin_payment_amount !== undefined) payload.no_pin_payment_amount = no_pin_payment_amount;
    if (spending_controls)                   payload.spending_controls     = spending_controls;
    if (risk_controls)                       payload.risk_controls         = risk_controls;
    if (metadata)                            payload.metadata              = metadata;

    const data = await UqpayService.updateCard(id, payload);
    res.json({ success: true, message: 'Card updated successfully', data });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ success: false, message: msg });
  }
};
