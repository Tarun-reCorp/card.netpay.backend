const mongoose = require('mongoose');
const { Schema } = mongoose;

const userSchema = new Schema({
  merchantId:              { type: Schema.Types.ObjectId, ref: 'Merchant', default: null },
  name:                    { type: String, required: true, trim: true },
  firstName:               { type: String, default: null },
  lastName:                { type: String, default: null },
  email:                   { type: String, required: true, unique: true, lowercase: true, trim: true },
  emailVerifiedAt:         { type: Date, default: null },
  password:                { type: String, required: true },
  twoFactorSecret:         { type: String, default: null },
  twoFactorEnabled:        { type: Boolean, default: false },
  mpin:                    { type: String, default: null },
  referralCode:            { type: String, default: null },
  kycStatus:               { type: String, enum: ['not_submitted', 'pending', 'in_review', 'approved', 'rejected'], default: 'not_submitted' },
  kycDocType:              { type: String, default: null },
  kycDocFront:             { type: String, default: null },
  kycDocBack:              { type: String, default: null },
  kycSelfie:               { type: String, default: null },
  kycDob:                  { type: Date, default: null },
  kycIdNumber:             { type: String, default: null },
  kycIssueDate:            { type: Date, default: null },
  kycExpiryDate:           { type: Date, default: null },
  kycRejectReason:         { type: String, default: null },
  kycSubmittedAt:          { type: Date, default: null },
  kycReviewedBy:           { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  kycReviewedAt:           { type: Date, default: null },
  kycReviewNote:           { type: String, default: null },
  isAdmin:                 { type: Boolean, default: false },
  isBlocked:               { type: Boolean, default: false },
  gender:                  { type: String, default: null },
  birthday:                { type: Date, default: null },
  country:                 { type: String, default: null }, // ISO-2 (e.g. "IN") — used for UQPay
  countryName:             { type: String, default: null }, // Full name (e.g. "India")
  phone:                   { type: String, default: null },
  areaCode:                { type: String, default: null },
  mobile:                  { type: String, default: null },
  town:                    { type: String, default: null },
  address:                 { type: String, default: null },
  postCode:                { type: String, default: null },
}, { timestamps: true, collection: 'users' });

userSchema.index({ email: 1 });
userSchema.index({ merchantId: 1 });
userSchema.index({ kycStatus: 1 });

module.exports = mongoose.model('User', userSchema);
