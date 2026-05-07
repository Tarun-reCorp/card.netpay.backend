const mongoose = require('mongoose');
const { Schema } = mongoose;

const commissionLedgerSchema = new Schema({
  userId:           { type: Schema.Types.ObjectId, ref: 'User', required: true },
  transactionId:    { type: String, default: null },
  type:             { type: String, enum: ['deposit', 'withdrawal', 'card_issuance', 'card_issuance_virtual', 'card_issuance_physical', 'card_topup'], required: true },
  grossAmount:      { type: Number, required: true },
  commissionAmount: { type: Number, required: true },
  netAmount:        { type: Number, required: true },
  rateType:         { type: String, enum: ['percentage', 'fixed'], required: true },
  rate:             { type: Number, required: true },
}, { timestamps: true, collection: 'commission_ledger' });

commissionLedgerSchema.index({ userId: 1 });
commissionLedgerSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('CommissionLedger', commissionLedgerSchema);
