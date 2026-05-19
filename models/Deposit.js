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
depositSchema.index({ userId: 1, createdAt: -1 });
// Uniqueness over `txHash` alone (not (chain, txHash)).
// Reason: EVM chains (BEP20, ERC20, POLYGON, ARBITRUM, BASE, AVALANCHE,
// OPTIMISM) all share the same 0x… address format and HD-derive from one
// key, so the same address shows up on every EVM chain. If we keyed on
// (chain, txHash), a polled deposit could be credited once as BEP20 and
// again as POLYGON whenever Cryptrum mislabels or repeats the row across
// payment-method IDs. Post-EIP-155 every signed tx is bound to a single
// chain-id, so a real txHash is globally unique by construction; keying
// on txHash closes the cross-chain replay hole.
// Synthetic txHashes (TEST-… / ADMIN-…) include random hex so they
// coexist; manual-deposit re-clicks still see E11000 and return the
// "already submitted" message.
// Migration: see scripts/migrateDepositIndexes.js — drops the old
// uniq_chain_txhash index before the new one is built.
depositSchema.index(
  { txHash: 1 },
  {
    unique: true,
    partialFilterExpression: { txHash: { $type: 'string' } },
    name: 'uniq_txhash',
  }
);

module.exports = mongoose.model('Deposit', depositSchema);
