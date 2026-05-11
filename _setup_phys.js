require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const User = require('./models/User');
const Wallet = require('./models/Wallet');
const PhysicalCardNumber = require('./models/PhysicalCardNumber');

const EMAIL = process.argv[2];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await User.findOne({ email: EMAIL });
  if (!u) { console.log('user not found'); process.exit(1); }
  u.kycStatus = 'approved';
  u.country = 'IN'; u.areaCode = '+91'; u.mobile = '9876588001';
  await u.save();
  let w = await Wallet.findOne({ userId: u._id });
  if (!w) w = await Wallet.create({ userId: u._id, balance: 1000 });
  else { w.balance = 1000; await w.save(); }
  // release any other pre-assignment for this user, then claim 4096...1514
  await PhysicalCardNumber.updateMany(
    { preAssignedUserId: u._id, isUsed: false },
    { $set: { preAssignedUserId: null, preAssignedAt: null } }
  );
  const c = await PhysicalCardNumber.findOneAndUpdate(
    { cardNumber: '4096360800121514' },
    { $set: { isUsed: false, usedAt: null, cardId: null, preAssignedUserId: u._id, preAssignedAt: new Date() } },
    { new: true }
  );
  console.log({ userId: u._id.toString(), kyc: u.kycStatus, country: u.country, balance: w.balance, card: c?.cardNumber, isUsed: c?.isUsed });
  process.exit(0);
})();
