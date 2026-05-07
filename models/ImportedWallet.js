const mongoose = require('mongoose');
const { Schema } = mongoose;

const importedWalletSchema = new Schema({
  userId:            { type: Schema.Types.ObjectId, ref: 'User', required: true },
  label:             { type: String, default: 'Imported Wallet' },
  encryptedMnemonic: { type: String, required: true },
  encryptionIv:      { type: String, required: true },
  encryptionTag:     { type: String, required: true },
  evmAddress:        { type: String, required: true },
  tronAddress:       { type: String, required: true },
  isMonitored:       { type: Boolean, default: true },
}, { timestamps: true, collection: 'imported_wallets' });

importedWalletSchema.index({ userId: 1 });

module.exports = mongoose.model('ImportedWallet', importedWalletSchema);
