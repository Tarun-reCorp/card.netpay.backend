const mongoose = require('mongoose');
const { Schema } = mongoose;

const walletSchema = new Schema({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  balance:  { type: Number, default: 0 },
  locked:   { type: Number, default: 0 },
  credit:   { type: Number, default: 0 },
  currency: { type: String, default: 'INR', maxlength: 3 },
}, { timestamps: true, collection: 'wallets' });

module.exports = mongoose.model('Wallet', walletSchema);
