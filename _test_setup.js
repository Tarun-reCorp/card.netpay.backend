require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User   = require('./models/User');
const Wallet = require('./models/Wallet');

const TARGET_EMAIL = process.argv[2] || 'user@netpay.com';
const TARGET_MOBILE = process.argv[3] || '3001234567';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ email: TARGET_EMAIL });
  if (!user) { console.log('user not found:', TARGET_EMAIL); process.exit(1); }

  user.firstName = user.firstName || (user.name || 'Demo').split(' ')[0];
  user.lastName  = user.lastName  || (user.name || 'User').split(' ').slice(1).join(' ') || 'User';
  user.country   = 'PK';
  user.areaCode  = '+92';
  user.mobile    = TARGET_MOBILE;
  user.kycStatus = 'approved';
  await user.save();

  let wallet = await Wallet.findOne({ userId: user._id });
  if (!wallet) wallet = await Wallet.create({ userId: user._id, balance: 1000 });
  else { wallet.balance = 1000; await wallet.save(); }

  console.log({
    userId: user._id.toString(),
    email:  user.email,
    country: user.country, areaCode: user.areaCode, mobile: user.mobile,
    kyc: user.kycStatus,
    balance: wallet.balance,
  });
  process.exit(0);
})();
