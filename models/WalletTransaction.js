const mongoose = require('mongoose');
const { Schema } = mongoose;
const { TRANSACTION_STATUS, TRANSACTION_STATUS_VALUES } = require('../config/statuses');

const walletTransactionSchema = new Schema({
  userId:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
  walletId:       { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
  type:           { type: String, enum: ['deposit', 'withdraw', 'card_issuance', 'card_issuance_virtual', 'card_issuance_physical', 'card_deposit', 'card_withdraw'], required: true },
  amount:         { type: Number, required: true },
  status:         { type: String, enum: TRANSACTION_STATUS_VALUES, default: TRANSACTION_STATUS.PENDING },
  paymentGateway: { type: String, default: null },
  transactionId:  { type: String, unique: true, required: true },
  referenceId:    { type: String, default: null },
  qrData:         { type: String, default: null },
  notes:          { type: String, default: null },
  completedAt:    { type: Date, default: null },
  coinKey:        { type: String, default: null },
  chain:          { type: String, default: null },
  coinName:       { type: String, default: null },
  depositAddress: { type: String, default: null },
  txHash:         { type: String, default: null },
  blockHeight:    { type: Number, default: null },
  wsbOrderNo:     { type: String, default: null },
}, { timestamps: true, collection: 'wallet_transactions' });

// transactionId: already covered by the field-level `unique: true` above.
walletTransactionSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
