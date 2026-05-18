const mongoose = require('mongoose');
const { Schema } = mongoose;

const uqpayCardholderSchema = new Schema({
  userId:            { type: Schema.Types.ObjectId, ref: 'User', default: null },
  adminId:           { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  cardholder_id:     { type: String, required: true, unique: true },
  cardholder_status: { type: String, required: true },
  first_name:        { type: String, required: true },
  last_name:         { type: String, required: true },
  email:             { type: String, required: true, lowercase: true, trim: true },
  country_code:      { type: String, required: true },
  phone_number:      { type: String, required: true },
  date_of_birth:     { type: String, default: null },
  gender:            { type: String, default: null },
  nationality:       { type: String, default: null },
  document_type:     { type: String, default: null },
}, { timestamps: true, collection: 'uqpay_cardholders' });

// cardholder_id: already covered by the field-level `unique: true` above.
uqpayCardholderSchema.index({ email: 1 });

module.exports = mongoose.model('UqpayCardholder', uqpayCardholderSchema);
