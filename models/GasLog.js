const mongoose = require('mongoose');
const { Schema } = mongoose;

const gasLogSchema = new Schema({
  chain:         { type: String, required: true, enum: ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'] },
  type:          { type: String, enum: ['gas_fund', 'sweep_gas', 'withdrawal_gas', 'admin_topup'], required: true },
  fromAddress:   { type: String, required: true },
  toAddress:     { type: String, required: true },
  amount:        { type: Number, required: true },
  txHash:        { type: String, default: null },
  referenceType: { type: String, default: null },
  referenceId:   { type: String, default: null },
  description:   { type: String, default: null },
}, { timestamps: false, collection: 'gas_logs' });

gasLogSchema.add({ createdAt: { type: Date, default: Date.now } });
gasLogSchema.index({ chain: 1, createdAt: -1 });

module.exports = mongoose.model('GasLog', gasLogSchema);
