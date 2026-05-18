const mongoose = require('mongoose');
const { Schema } = mongoose;

const FIXED_RATE_MAX = 10000;
const merchantCommissionRateValidator = {
  validator: function (v) {
    if (!Number.isFinite(v) || v < 0) return false;
    if (this.rateType === 'percentage') return v <= 100;
    return v <= FIXED_RATE_MAX;
  },
  message: props => `Merchant commission rate ${props.value} is out of bounds.`,
};

const merchantCommissionSettingSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  type:       { type: String, enum: ['deposit', 'withdrawal', 'card_issuance_virtual', 'card_issuance_physical', 'card_deposit', 'card_withdrawal'], required: true },
  rateType:   { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:       { type: Number, default: 0, validate: merchantCommissionRateValidator },
}, { timestamps: true, collection: 'merchant_commission_settings' });

merchantCommissionSettingSchema.index({ merchantId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('MerchantCommissionSetting', merchantCommissionSettingSchema);
