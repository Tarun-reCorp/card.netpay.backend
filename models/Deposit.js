const mongoose = require('mongoose');
const { Schema } = mongoose;

const CHAINS = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'];

const depositSchema = new Schema({
  userId:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
  chain:         { type: String, enum: CHAINS, required: true },
  asset:         { type: String, default: 'USDT' },
  amount:        { type: Number, required: true },
  txHash:        { type: String, unique: true, required: true },
  fromAddress:   { type: String, default: null },
  toAddress:     { type: String, required: true },
  blockNumber:   { type: Number, default: null },
  confirmations: { type: Number, default: 0 },
  requiredConfs: { type: Number, default: 15 },
  status:        { type: String, enum: ['pending', 'confirming', 'confirmed'], default: 'pending' },
  creditedAt:    { type: Date, default: null },
}, { timestamps: true, collection: 'deposits' });

depositSchema.index({ toAddress: 1, status: 1 });
depositSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('Deposit', depositSchema);
