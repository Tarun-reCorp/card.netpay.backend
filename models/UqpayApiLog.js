const mongoose = require('mongoose');
const { Schema } = mongoose;

const uqpayApiLogSchema = new Schema({
  method:          { type: String, required: true, uppercase: true, maxlength: 10 },
  path:            { type: String, required: true, index: true },
  requestPayload:  { type: String, default: null },
  responseBody:    { type: String, default: null },
  httpStatus:      { type: Number, default: null },
  success:         { type: Boolean, default: false, index: true },
  errorMessage:    { type: String, default: null },
  durationMs:      { type: Number, default: null },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, collection: 'uqpay_api_logs' });

uqpayApiLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('UqpayApiLog', uqpayApiLogSchema);
