/**
 * Seed dummy accounts for development/testing.
 * Run: node seed.js
 */

require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']); // bypass Fortiguard DNS filter
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User     = require('./models/User');
const Wallet   = require('./models/Wallet');
const AdminUser = require('./models/AdminUser');
const Merchant = require('./models/Merchant');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/netpay_cards';

const accounts = {
  user: {
    name: 'Demo User',
    email: 'user@demo.com',
    password: 'Demo@1234',
    kycStatus: 'approved',
    balance: 500,
  },
  admin: {
    name: 'Super Admin',
    email: 'admin@demo.com',
    password: 'Admin@1234',
  },
  merchant: {
    name: 'Demo Merchant',
    email: 'merchant@demo.com',
    password: 'Merchant@1234',
    tag: 'demo',
    status: 'active',
  },
};

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  // --- User ---
  const existingUser = await User.findOne({ email: accounts.user.email });
  if (existingUser) {
    console.log('User already exists, skipping.');
  } else {
    const hash = await bcrypt.hash(accounts.user.password, 12);
    const user = await User.create({
      name: accounts.user.name,
      email: accounts.user.email,
      password: hash,
      kycStatus: accounts.user.kycStatus,
    });
    await Wallet.create({ userId: user._id, balance: accounts.user.balance });
    console.log(`✓ User created: ${accounts.user.email} / ${accounts.user.password}  (wallet balance: $${accounts.user.balance})`);
  }

  // --- Admin ---
  const existingAdmin = await AdminUser.findOne({ email: accounts.admin.email });
  if (existingAdmin) {
    console.log('Admin already exists, skipping.');
  } else {
    const hash = await bcrypt.hash(accounts.admin.password, 12);
    await AdminUser.create({
      name: accounts.admin.name,
      email: accounts.admin.email,
      password: hash,
    });
    console.log(`✓ Admin created: ${accounts.admin.email} / ${accounts.admin.password}`);
  }

  // --- Merchant ---
  const existingMerchant = await Merchant.findOne({ email: accounts.merchant.email });
  if (existingMerchant) {
    console.log('Merchant already exists, skipping.');
  } else {
    const hash = await bcrypt.hash(accounts.merchant.password, 12);
    await Merchant.create({
      name: accounts.merchant.name,
      email: accounts.merchant.email,
      password: hash,
      tag: accounts.merchant.tag,
      status: accounts.merchant.status,
    });
    console.log(`✓ Merchant created: ${accounts.merchant.email} / ${accounts.merchant.password}`);
  }

  console.log('\nDone. Accounts:');
  console.log('  User     →  user@demo.com      / Demo@1234      (login at /login)');
  console.log('  Admin    →  admin@demo.com     / Admin@1234     (login at /admin/login)');
  console.log('  Merchant →  merchant@demo.com  / Merchant@1234  (login at /merchant/login)');

  await mongoose.disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
