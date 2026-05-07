const mongoose = require('mongoose');
const { Schema } = mongoose;

const commissionSettingSchema = new Schema({
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'card_issuance', 'card_issuance_virtual', 'card_issuance_physical', 'card_topup'],
    required: true,
    unique: true,
  },
  rateType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:     { type: Number, default: 0 },
}, { timestamps: true, collection: 'commission_settings' });

module.exports = mongoose.model('CommissionSetting', commissionSettingSchema);
