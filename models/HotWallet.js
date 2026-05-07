const mongoose = require('mongoose');
const { Schema } = mongoose;

const hotWalletSchema = new Schema({
  label:                 { type: String, default: null },
  derivationIndex:       { type: Number, required: true, unique: true },
  derivationPath:        { type: String, required: true },
  evmAddress:            { type: String, required: true, unique: true },
  tronAddress:           { type: String, required: true, unique: true },
  enabled:               { type: Boolean, default: true },
  totalSweepCount:       { type: Number, default: 0 },
  totalWithdrawalCount:  { type: Number, default: 0 },
  lastUsedForSweep:      { type: Date, default: null },
  lastUsedForWithdrawal: { type: Date, default: null },
}, { timestamps: true, collection: 'hot_wallets' });

module.exports = mongoose.model('HotWallet', hotWalletSchema);
