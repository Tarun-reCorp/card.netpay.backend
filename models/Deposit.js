const mongoose = require('mongoose');
const { Schema } = mongoose;
const { DEPOSIT_STATUS, DEPOSIT_STATUS_VALUES } = require('../config/statuses');

const CHAINS = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM', 'BNB', 'TEST'];

const depositSchema = new Schema({
  userId:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
  chain:           { type: String, enum: CHAINS, default: null },
  asset:           { type: String, default: 'USDT' },
  amount:          { type: Number, required: true },
  txHash:          { type: String, default: null },
  transactionId:   { type: String, default: null },
  fromAddress:     { type: String, default: null },
  toAddress:       { type: String, default: null },
  blockNumber:     { type: Number, default: null },
  confirmations:   { type: Number, default: 0 },
  requiredConfs:   { type: Number, default: 15 },
  source:          { type: String, enum: ['auto', 'manual'], default: 'auto' },
  notes:           { type: String, default: null },
  verifiedOnChain: { type: Boolean, default: false },
  status:          { type: String, enum: DEPOSIT_STATUS_VALUES, default: DEPOSIT_STATUS.PENDING },
  creditedAt:      { type: Date, default: null },
  rejectedAt:      { type: Date, default: null },
  rejectionReason: { type: String, default: null },
}, { timestamps: true, collection: 'deposits' });

depositSchema.index({ toAddress: 1, status: 1 });
depositSchema.index({ userId: 1, status: 1 });
// Uniqueness over (chain, txHash) when txHash is a non-empty string.
// Prevents a chain re-scan / scanner restart / user double-submit from
// inserting the same on-chain transaction twice. Synthetic txHashes
// (TEST-…, ADMIN-…) carry sufficient random entropy to coexist; admin
// manual-deposit may need a retry on a same-millisecond click.
depositSchema.index(
  { chain: 1, txHash: 1 },
  {
    unique: true,
    partialFilterExpression: { txHash: { $type: 'string' } },
    name: 'uniq_chain_txhash',
  }
);

module.exports = mongoose.model('Deposit', depositSchema);
