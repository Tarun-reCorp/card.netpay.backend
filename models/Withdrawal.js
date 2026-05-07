const mongoose = require('mongoose');
const { Schema } = mongoose;

const CHAINS = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'];

const withdrawalSchema = new Schema({
  userId:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
  chain:           { type: String, enum: CHAINS, required: true },
  asset:           { type: String, default: 'USDT' },
  amount:          { type: Number, required: true },
  fee:             { type: Number, default: 0 },
  toAddress:       { type: String, required: true },
  txHash:          { type: String, default: null },
  fromAddress:     { type: String, default: null },
  hotWalletId:     { type: Schema.Types.ObjectId, ref: 'HotWallet', default: null },
  status:          { type: String, enum: ['pending', 'approved', 'processing', 'completed', 'failed', 'rejected'], default: 'pending' },
  approvedBy:      { type: Schema.Types.ObjectId, ref: 'User', default: null },
  rejectionReason: { type: String, default: null },
  processedAt:     { type: Date, default: null },
}, { timestamps: true, collection: 'withdrawals' });

withdrawalSchema.index({ userId: 1, status: 1 });
withdrawalSchema.index({ status: 1 });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
