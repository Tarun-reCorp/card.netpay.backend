const mongoose = require('mongoose');
const { Schema } = mongoose;

const adminWalletSchema = new Schema({
  label:                 { type: String, required: true },
  evmAddress:            { type: String, required: true, unique: true },
  tronAddress:           { type: String, default: null },
  encryptedPrivateKey:   { type: String, required: true },
  encryptionIv:          { type: String, required: true },
  encryptionTag:         { type: String, required: true },
  walletType:            { type: String, enum: ['hot', 'treasury'], default: 'hot' },
  enabled:               { type: Boolean, default: true },
  chainsEnabled:         { type: [String], default: null },
  totalWithdrawalCount:  { type: Number, default: 0 },
  totalSweepCount:       { type: Number, default: 0 },
  lastUsedForWithdrawal: { type: Date, default: null },
  notes:                 { type: String, default: null },
}, { timestamps: true, collection: 'admin_wallets' });

module.exports = mongoose.model('AdminWallet', adminWalletSchema);
