const mongoose = require('mongoose');
const { Schema } = mongoose;
const { MERCHANT_STATUS_VALUES } = require('../config/statuses');

const merchantSchema = new Schema({
  name:               { type: String, required: true, trim: true },
  tag:                { type: String, unique: true, sparse: true, default: null, lowercase: true },
  email:              { type: String, required: true, unique: true, lowercase: true },
  password:           { type: String, required: true },
  phone:              { type: String, default: null },
  status:             { type: String, enum: MERCHANT_STATUS_VALUES, required: true },
  type:               { type: String, enum: ['whitelabel', 'netpay_owned'], default: 'netpay_owned' },
  titleTag:           { type: String, default: null },
  showPoweredBy:      { type: Boolean, default: true },
  logo:               { type: String, default: null },
  primaryColor:       { type: String, default: null },
  secondaryColor:     { type: String, default: null },
  cardImage:          { type: String, default: null },
  virtualMinDeposit:  { type: Number, default: null },
  physicalMinDeposit: { type: Number, default: null },
  twoFactorSecret:    { type: String, default: null },
  twoFactorEnabled:   { type: Boolean, default: false },
  twoFactorRequired:  { type: Boolean, default: false },
}, { timestamps: true, collection: 'merchants' });

module.exports = mongoose.model('Merchant', merchantSchema);
