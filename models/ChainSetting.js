const mongoose = require('mongoose');
const { Schema } = mongoose;

const chainSettingSchema = new Schema({
  chain:           { type: String, required: true, unique: true, enum: ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'] },
  enabled:         { type: Boolean, default: true },
  depositEnabled:  { type: Boolean, default: true },
  withdrawEnabled: { type: Boolean, default: true },
}, { timestamps: true, collection: 'chain_settings' });

module.exports = mongoose.model('ChainSetting', chainSettingSchema);
