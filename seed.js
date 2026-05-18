require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const AdminUser  = require('./models/AdminUser');
const Merchant   = require('./models/Merchant');
const User       = require('./models/User');
const Card       = require('./models/Card');
const PhysicalCardNumber = require('./models/PhysicalCardNumber');

const CommissionSetting = require('./models/CommissionSetting');
const AppSetting        = require('./models/AppSetting');

let CommissionLedger;
try { CommissionLedger = require('./models/CommissionLedger'); } catch {}

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected to MongoDB');

  // ── Admin ──────────────────────────────────────────────────────────────────
  const adminEmail = 'admin@netpay.com';
  let admin = await AdminUser.findOne({ email: adminEmail });
  if (!admin) {
    admin = await AdminUser.create({
      name: 'Super Admin',
      email: adminEmail,
      password: await bcrypt.hash('Admin@123', 10),
      isActive: true,
    });
    console.log('Created admin:', adminEmail, '/ Admin@123');
  } else {
    console.log('Admin exists:', adminEmail);
  }

  // ── Merchant ───────────────────────────────────────────────────────────────
  const merchantEmail = 'merchant@netpay.com';
  let merchant = await Merchant.findOne({ email: merchantEmail });
  if (!merchant) {
    merchant = await Merchant.create({
      name: 'Demo Merchant',
      email: merchantEmail,
      password: await bcrypt.hash('Merchant@123', 10),
      phone: '+1-555-1001',
      status: 'active',
      tag: `demo_${Date.now()}`,
      type: 'netpay_owned',
    });
    console.log('Created merchant:', merchantEmail, '/ Merchant@123');
  } else {
    console.log('Merchant exists:', merchantEmail);
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  const userDefs = [
    { name: 'Alice Johnson', email: 'alice@test.com', phone: '+1-555-2001', kycStatus: 'approved' },
    { name: 'Bob Smith',     email: 'bob@test.com',   phone: '+1-555-2002', kycStatus: 'pending'  },
    { name: 'Carol White',   email: 'carol@test.com', phone: '+1-555-2003', kycStatus: 'approved' },
    { name: 'Demo User',     email: 'user@netpay.com',phone: '+1-555-2004', kycStatus: 'approved' },
  ];

  const userMap = {};
  for (const ud of userDefs) {
    let u = await User.findOne({ email: ud.email });
    if (!u) {
      u = await User.create({
        name: ud.name, email: ud.email, phone: ud.phone,
        password: await bcrypt.hash('User@123', 10),
        kycStatus: ud.kycStatus,
        merchantId: merchant._id,
        isActive: true,
      });
      console.log('Created user:', ud.email);
    } else {
      if (!u.merchantId) { u.merchantId = merchant._id; await u.save(); }
      console.log('User exists:', ud.email);
    }
    userMap[ud.email] = u;
  }

  // ── Cards ──────────────────────────────────────────────────────────────────
  const cardDefs = [
    { email: 'alice@test.com', cardNo: '4111111111111234', cardType: 'virtual',  status: 'active',    balance: 250.00, expireDate: '12/27' },
    { email: 'alice@test.com', cardNo: '4111111111115678', cardType: 'physical', status: 'active',    balance: 100.50, expireDate: '06/28' },
    { email: 'bob@test.com',   cardNo: '4111111111119012', cardType: 'virtual',  status: 'frozen',    balance: 0,      expireDate: '03/27' },
    { email: 'carol@test.com', cardNo: '4111111111113456', cardType: 'virtual',  status: 'pending',   balance: 500.00, expireDate: '09/27' },
    { email: 'carol@test.com', cardNo: '4111111111117890', cardType: 'physical', status: 'cancelled', balance: 0,      expireDate: '01/26' },
  ];

  for (const cd of cardDefs) {
    const user = userMap[cd.email];
    if (!user) continue;
    const existing = await Card.findOne({ cardNo: cd.cardNo });
    if (!existing) {
      await Card.create({
        userId: user._id,
        cardNo: cd.cardNo,
        cardType: cd.cardType,
        status: cd.status,
        balance: cd.balance,
        expireDate: cd.expireDate,
        holderName: user.name,
        holderEmail: user.email,
      });
      console.log('Created card:', cd.cardNo.slice(-4), 'for', cd.email);
    } else {
      console.log('Card exists:', cd.cardNo.slice(-4));
    }
  }

  // ── Physical Card Numbers ──────────────────────────────────────────────────
  const physDefs = [
    { cardNumber: 'PC-0001', isUsed: false, preAssignedUserId: null },
    { cardNumber: 'PC-0002', isUsed: false, preAssignedUserId: userMap['alice@test.com']?._id },
    { cardNumber: 'PC-0003', isUsed: true  },
    { cardNumber: 'PC-0004', isUsed: false, preAssignedUserId: null },
  ];

  for (const pd of physDefs) {
    const existing = await PhysicalCardNumber.findOne({ cardNumber: pd.cardNumber });
    if (!existing) {
      await PhysicalCardNumber.create({
        cardNumber: pd.cardNumber,
        merchantId: merchant._id,
        isUsed: pd.isUsed,
        preAssignedUserId: pd.preAssignedUserId || null,
        preAssignedAt: pd.preAssignedUserId ? new Date() : null,
      });
      console.log('Created physical card:', pd.cardNumber);
    } else {
      console.log('Physical card exists:', pd.cardNumber);
    }
  }

  // ── Chain Settings ─────────────────────────────────────────────────────────
  const ChainSetting = require('./models/ChainSetting');
  const chains = ['BEP20', 'TRC20', 'ERC20', 'POLYGON', 'ARBITRUM', 'BASE', 'AVALANCHE', 'OPTIMISM'];
  for (const chain of chains) {
    const exists = await ChainSetting.findOne({ chain });
    if (!exists) {
      await ChainSetting.create({ chain, enabled: true, depositEnabled: true, withdrawEnabled: true });
      console.log('Created chain setting:', chain);
    } else {
      console.log('Chain exists:', chain);
    }
  }

  // ── Commission Settings ────────────────────────────────────────────────────
  const commDefaults = [
    { type: 'card_issuance_virtual',  rateType: 'fixed',      rate: 10   },
    { type: 'card_issuance_physical', rateType: 'fixed',      rate: 50   },
    { type: 'card_deposit',           rateType: 'percentage', rate: 0    },
    { type: 'card_withdrawal',        rateType: 'percentage', rate: 0    },
    { type: 'deposit',                rateType: 'percentage', rate: 1.75 },
    { type: 'withdrawal',             rateType: 'percentage', rate: 1    },
  ];
  for (const d of commDefaults) {
    await CommissionSetting.findOneAndUpdate({ type: d.type }, d, { upsert: true });
  }
  console.log('Commission settings seeded');

  // ── App Settings ───────────────────────────────────────────────────────────
  await AppSetting.findOneAndUpdate({ key: 'virtual_card_min_deposit' },  { value: '50' }, { upsert: true });
  await AppSetting.findOneAndUpdate({ key: 'physical_card_min_deposit' }, { value: '50' }, { upsert: true });
  console.log('App settings seeded');

  // ── Commission Ledger ──────────────────────────────────────────────────────
  if (CommissionLedger) {
    const alice = userMap['alice@test.com'];
    const bob   = userMap['bob@test.com'];
    const ledgerCount = await CommissionLedger.countDocuments();
    if (ledgerCount === 0 && alice && bob) {
      await CommissionLedger.insertMany([
        { userId: alice._id, transactionId: 'AUTO-001', type: 'deposit',                grossAmount: 500,  commissionAmount: 8.75,  netAmount: 491.25, rateType: 'percentage', rate: 1.75 },
        { userId: bob._id,   transactionId: 'AUTO-002', type: 'deposit',                grossAmount: 750,  commissionAmount: 13.125, netAmount: 736.875, rateType: 'percentage', rate: 1.75 },
        { userId: alice._id, transactionId: 'CARD-001', type: 'card_issuance_virtual',  grossAmount: 60,   commissionAmount: 10,    netAmount: 50,     rateType: 'fixed',      rate: 10 },
        { userId: bob._id,   transactionId: 'CARD-002', type: 'card_issuance_physical', grossAmount: 150,  commissionAmount: 50,    netAmount: 100,    rateType: 'fixed',      rate: 50 },
        { userId: alice._id, transactionId: 'WD-001',   type: 'withdrawal',             grossAmount: 1000, commissionAmount: 10,    netAmount: 990,    rateType: 'percentage', rate: 1 },
        { userId: bob._id,   transactionId: 'CDEP-001', type: 'card_deposit',           grossAmount: 700,  commissionAmount: 3.5,   netAmount: 696.5,  rateType: 'percentage', rate: 0.5 },
      ]);
      console.log('CommissionLedger seeded: 6 records');
    } else {
      console.log('CommissionLedger already has data or users missing');
    }
  }

  console.log('\n========================================');
  console.log('Seed complete. Credentials:');
  console.log('  Admin:    admin@netpay.com / Admin@123');
  console.log('  Merchant: merchant@netpay.com / Merchant@123');
  console.log('  User:     user@netpay.com / User@123');
  console.log('  User:     alice@test.com / User@123');
  console.log('  User:     bob@test.com / User@123');
  console.log('========================================\n');

  await mongoose.disconnect();
  process.exit(0);
}).catch(e => { console.error('Seed error:', e.message); process.exit(1); });
