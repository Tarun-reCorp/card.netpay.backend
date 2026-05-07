const mongoose = require('mongoose');
const { Schema } = mongoose;

const adminUserSchema = new Schema({
  name:     { type: String, required: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true, collection: 'admin_users' });

module.exports = mongoose.model('AdminUser', adminUserSchema);
