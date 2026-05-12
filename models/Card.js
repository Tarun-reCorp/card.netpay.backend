const mongoose = require('mongoose');
const { Schema } = mongoose;

const cardSchema = new Schema({
  userId:             { type: Schema.Types.ObjectId, ref: 'User', required: true },
  uqpayCardId:        { type: String, default: null },
  uqpayCardholderId:  { type: String, default: null },
  cardNo:             { type: String, default: null },
  organization:       { type: String, enum: ['MasterCard', 'Visa', 'UnionPay', 'Amex', 'Discover'], default: null },
  currency:           { type: String, default: 'USD' },
  cardType:           { type: String, enum: ['virtual', 'physical'], default: 'virtual' },
  deliveryInfo:       { type: Schema.Types.Mixed, default: null },
  status:             { type: String, enum: ['pending', 'active', 'frozen', 'cancelled', 'processing', 'failed'], default: 'pending' },
  balance:            { type: Number, default: 0 },
  expireDate:         { type: String, default: null },
  depositAmount:      { type: Number, default: 0 },
  feeAmount:          { type: Number, default: 0 },
  merchantOrderNo:    { type: String, default: null },
  holderEmail:        { type: String, default: null },
  holderMobile:       { type: String, default: null },
}, { timestamps: true, collection: 'cards' });

cardSchema.index({ userId: 1 });
cardSchema.index({ uqpayCardId: 1 });

module.exports = mongoose.model('Card', cardSchema);
