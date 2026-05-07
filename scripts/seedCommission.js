require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const CommissionSetting = require('../models/CommissionSetting');
const AppSetting = require('../models/AppSetting');

const defaults = [
  { type: 'card_issuance_virtual',  rateType: 'fixed',      rate: 10   },
  { type: 'card_issuance_physical', rateType: 'fixed',      rate: 50   },
  { type: 'deposit',                rateType: 'percentage', rate: 1.75 },
  { type: 'withdrawal',             rateType: 'percentage', rate: 1    },
];

mongoose.connect(process.env.MONGO_URI).then(async () => {
  for (const d of defaults) {
    const existing = await CommissionSetting.findOne({ type: d.type });
    if (!existing) {
      await CommissionSetting.create(d);
      console.log('Created:', d.type, d.rateType, d.rate);
    } else {
      console.log('Already exists:', d.type);
    }
  }
  await AppSetting.findOneAndUpdate({ key: 'virtual_card_min_deposit' },  { value: '50' }, { upsert: true });
  await AppSetting.findOneAndUpdate({ key: 'physical_card_min_deposit' }, { value: '50' }, { upsert: true });
  console.log('AppSettings: virtual_card_min_deposit=50, physical_card_min_deposit=50');
  await mongoose.disconnect();
  console.log('Done.');
}).catch(e => { console.error(e); process.exit(1); });
