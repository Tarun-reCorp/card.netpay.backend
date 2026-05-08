const mongoose = require('mongoose');
const { Schema } = mongoose;

const uqpayTokenSchema = new Schema({
  auth_token: { type: String, required: true },
  expired_at: { type: Number, required: true },
  is_active:  { type: Boolean, default: true },
}, { timestamps: true, collection: 'uqpay_tokens' });

module.exports = mongoose.model('UqpayToken', uqpayTokenSchema);
