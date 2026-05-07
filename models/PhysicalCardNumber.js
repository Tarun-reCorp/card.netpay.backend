const mongoose = require('mongoose');
const { Schema } = mongoose;

const physicalCardNumberSchema = new Schema({
  cardNumber:        { type: String, required: true, unique: true },
  isUsed:            { type: Boolean, default: false },
  cardId:            { type: Schema.Types.ObjectId, ref: 'Card', default: null },
  usedAt:            { type: Date, default: null },
  notes:             { type: String, default: null },
  merchantId:        { type: Schema.Types.ObjectId, ref: 'Merchant', default: null },
  preAssignedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  preAssignedAt:     { type: Date, default: null },
}, { timestamps: true, collection: 'physical_card_numbers' });

physicalCardNumberSchema.index({ isUsed: 1 });
physicalCardNumberSchema.index({ merchantId: 1 });

module.exports = mongoose.model('PhysicalCardNumber', physicalCardNumberSchema);
