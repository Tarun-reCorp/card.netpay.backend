const mongoose = require('mongoose');
const { Schema } = mongoose;

const walletAddressSchema = new Schema({
  userId:           { type: Schema.Types.ObjectId, ref: 'User', required: true },
  coinKey:          { type: String, required: true },
  chain:            { type: String, required: true, enum: ['TRC20', 'BEP20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'] },
  coinName:         { type: String, required: true },
  address:          { type: String, required: true },
  derivationIndex:  { type: Number, default: null },
  derivationPath:   { type: String, default: null },
  wsbOrderNo:       { type: String, default: null },
  isPlatformDerived:{ type: Boolean, default: true },
}, { timestamps: true, collection: 'wallet_addresses' });

walletAddressSchema.index({ userId: 1, coinKey: 1 }, { unique: true });

module.exports = mongoose.model('WalletAddress', walletAddressSchema);
