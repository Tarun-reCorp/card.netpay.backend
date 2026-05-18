const mongoose = require('mongoose');
const { Schema } = mongoose;

const uqpayCardSchema = new Schema({
  cardholderId:   { type: Schema.Types.ObjectId, ref: 'UqpayCardholder', default: null },
  userId:         { type: Schema.Types.ObjectId, ref: 'User', default: null },
  adminId:        { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  card_order_id:  { type: String, required: true, unique: true },
  card_id:        { type: String, required: true, unique: true },
  cardholder_id:  { type: String, required: true },
  card_status:    { type: String, required: true },
  order_status:   { type: String, required: true },
  card_currency:  { type: String, required: true, default: 'USD' },
  card_product_id:{ type: String, required: true },
  create_time:    { type: Date, default: Date.now },
}, { timestamps: true, collection: 'uqpay_cards' });

// cardholder_id: secondary lookup (not unique — one cardholder owns many cards).
// card_id: already covered by the field-level `unique: true` above; no extra index needed.
uqpayCardSchema.index({ cardholder_id: 1 });

module.exports = mongoose.model('UqpayCard', uqpayCardSchema);
