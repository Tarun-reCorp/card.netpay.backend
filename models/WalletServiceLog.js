const mongoose = require('mongoose');
const { Schema } = mongoose;

const walletServiceLogSchema = new Schema({
  category: { type: String, required: true, enum: ['deposit', 'sweep', 'withdrawal', 'error', 'system'] },
  level:    { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
  chain:    { type: String, default: null },
  userId:   { type: Schema.Types.ObjectId, ref: 'User', default: null },
  address:  { type: String, default: null },
  amount:   { type: Number, default: null },
  txHash:   { type: String, default: null },
  message:  { type: String, required: true },
  meta:     { type: Schema.Types.Mixed, default: null },
  createdAt:{ type: Date, default: Date.now },
}, { timestamps: false, collection: 'wallet_service_logs' });

walletServiceLogSchema.index({ createdAt: -1 });
walletServiceLogSchema.index({ userId: 1, category: 1 });

module.exports = mongoose.model('WalletServiceLog', walletServiceLogSchema);
