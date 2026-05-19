const mongoose = require('mongoose');
const { Schema } = mongoose;
const { WITHDRAWAL_STATUS, WITHDRAWAL_STATUS_VALUES } = require('../config/statuses');

// Keep in sync with models/Deposit.js — same canonical set Cryptrum uses.
const CHAINS = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM', 'BNB', 'TEST'];

const withdrawalSchema = new Schema({
  userId:           { type: Schema.Types.ObjectId, ref: 'User', required: true },
  chain:            { type: String, enum: CHAINS, required: true },
  asset:            { type: String, default: 'USDT' },
  amount:           { type: Number, required: true },
  fee:              { type: Number, default: 0 },
  toAddress:        { type: String, required: true },
  txHash:           { type: String, default: null },
  fromAddress:      { type: String, default: null },
  hotWalletId:      { type: Schema.Types.ObjectId, ref: 'HotWallet', default: null },
  // Cryptrum routing: paymentMethodId is captured at request time; cryptrumCode
  // is the withdraw_code returned by Cryptrum when the user submits — the
  // request is auto-pushed to the provider, not gated by admin approval.
  paymentMethodId:  { type: Number, default: null },
  cryptrumCode:     { type: String, default: null },
  status:           { type: String, enum: WITHDRAWAL_STATUS_VALUES, default: WITHDRAWAL_STATUS.PENDING },
  approvedBy:       { type: Schema.Types.ObjectId, ref: 'User', default: null },
  rejectionReason:  { type: String, default: null },
  processedAt:      { type: Date, default: null },
}, { timestamps: true, collection: 'withdrawals' });

withdrawalSchema.index({ userId: 1, status: 1 });
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ userId: 1, createdAt: -1 });
// cryptrumCode lookup by refreshWithdrawalStatus — sparse because synthetic
// (admin/manual) rows don't have one.
withdrawalSchema.index(
  { cryptrumCode: 1 },
  { partialFilterExpression: { cryptrumCode: { $type: 'string' } } },
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
