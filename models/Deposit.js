const mongoose = require('mongoose');
const { Schema } = mongoose;

const CHAINS = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'];

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
  status:          { type: String, enum: ['pending', 'confirming', 'confirmed', 'completed', 'rejected'], default: 'pending' },
  creditedAt:      { type: Date, default: null },
  rejectedAt:      { type: Date, default: null },
  rejectionReason: { type: String, default: null },
}, { timestamps: true, collection: 'deposits' });

depositSchema.index({ toAddress: 1, status: 1 });
depositSchema.index({ userId: 1, status: 1 });
depositSchema.index({ txHash: 1 }, { sparse: true });

module.exports = mongoose.model('Deposit', depositSchema);
