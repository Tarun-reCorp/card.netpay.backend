const mongoose = require('mongoose');
const { Schema } = mongoose;

const gasTreasurySchema = new Schema({
  walletType:        { type: String, enum: ['hot', 'admin', 'deposit'], required: true },
  walletId:          { type: Schema.Types.ObjectId, required: true },
  chain:             { type: String, required: true, enum: ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'] },
  nativeCurrency:    { type: String, required: true },
  nativeBalance:     { type: Number, default: 0 },
  usdtBalance:       { type: Number, default: 0 },
  lowThreshold:      { type: Number, default: 0 },
  criticalThreshold: { type: Number, default: 0 },
  lastSyncedAt:      { type: Date, default: null },
}, { timestamps: true, collection: 'gas_treasury' });

gasTreasurySchema.index({ walletType: 1, walletId: 1, chain: 1 }, { unique: true });

module.exports = mongoose.model('GasTreasury', gasTreasurySchema);
