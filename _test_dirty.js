require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User   = require('./models/User');
const Wallet = require('./models/Wallet');

const EMAIL = process.argv[2];
const COUNTRY = process.argv[3];
const AREA = process.argv[4];
const MOBILE = process.argv[5];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOne({ email: EMAIL });
  if (!user) { console.log('not found'); process.exit(1); }
  user.country = COUNTRY;
  user.areaCode = AREA;
  user.mobile = MOBILE;
  user.kycStatus = 'approved';
  await user.save();
  let w = await Wallet.findOne({ userId: user._id });
  if (!w) w = await Wallet.create({ userId: user._id, balance: 1000 });
  else { w.balance = 1000; await w.save(); }
  console.log({ email: user.email, country: user.country, areaCode: user.areaCode, mobile: user.mobile });
  process.exit(0);
})();
