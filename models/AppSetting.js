const mongoose = require('mongoose');
const { Schema } = mongoose;

const appSettingSchema = new Schema({
  key:   { type: String, required: true, unique: true, trim: true },
  value: { type: String, default: null },
}, { timestamps: true, collection: 'app_settings' });

module.exports = mongoose.model('AppSetting', appSettingSchema);
