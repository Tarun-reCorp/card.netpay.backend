const mongoose = require('mongoose');
const { Schema } = mongoose;

const userCommissionSettingSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type:     { type: String, enum: ['deposit', 'withdrawal', 'card_issuance'], required: true },
  rateType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  rate:     { type: Number, default: 0 },
}, { timestamps: true, collection: 'user_commission_settings' });

userCommissionSettingSchema.index({ userId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('UserCommissionSetting', userCommissionSettingSchema);
