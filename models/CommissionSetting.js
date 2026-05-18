const mongoose = require('mongoose');
const { Schema } = mongoose;

// Reasonable upper bound for a flat-fee commission. Tunable, but a fixed fee
// over $10,000 is almost certainly an admin typo and must not be silently
// accepted. Percentage rates are bounded to 100 because >100% deposit fee
// would imply a negative credit to the user.
const FIXED_RATE_MAX = 10000;

const commissionRateValidator = {
  validator: function (v) {
    if (!Number.isFinite(v) || v < 0) return false;
    if (this.rateType === 'percentage') return v <= 100;
    return v <= FIXED_RATE_MAX;
  },
  message: props => `Commission rate ${props.value} is out of bounds for type ${props.path}.`,
};

const commissionSettingSchema = new Schema({
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'card_issuance', 'card_issuance_virtual', 'card_issuance_physical', 'card_deposit', 'card_withdrawal'],
    required: true,
    unique: true,
  },
  rateType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:     { type: Number, default: 0, validate: commissionRateValidator },
}, { timestamps: true, collection: 'commission_settings' });

module.exports = mongoose.model('CommissionSetting', commissionSettingSchema);
