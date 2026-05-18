const mongoose = require('mongoose');
const { Schema } = mongoose;

const FIXED_RATE_MAX = 10000;
const userCommissionRateValidator = {
  validator: function (v) {
    if (!Number.isFinite(v) || v < 0) return false;
    if (this.rateType === 'percentage') return v <= 100;
    return v <= FIXED_RATE_MAX;
  },
  message: props => `User commission rate ${props.value} is out of bounds.`,
};

const userCommissionSettingSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type:     { type: String, enum: ['deposit', 'withdrawal', 'card_issuance', 'card_issuance_virtual', 'card_issuance_physical', 'card_deposit', 'card_withdrawal'], required: true },
  rateType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:     { type: Number, default: 0, validate: userCommissionRateValidator },
}, { timestamps: true, collection: 'user_commission_settings' });

userCommissionSettingSchema.index({ userId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('UserCommissionSetting', userCommissionSettingSchema);
