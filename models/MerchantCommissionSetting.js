const mongoose = require('mongoose');
const { Schema } = mongoose;

const merchantCommissionSettingSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  type:       { type: String, enum: ['deposit', 'withdrawal', 'card_issuance_virtual', 'card_issuance_physical'], required: true },
  rateType:   { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:       { type: Number, default: 0 },
}, { timestamps: true, collection: 'merchant_commission_settings' });

merchantCommissionSettingSchema.index({ merchantId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('MerchantCommissionSetting', merchantCommissionSettingSchema);
