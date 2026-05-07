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
const Deposit           = require('./models/Deposit');
const Withdrawal        = require('./models/Withdrawal');
const WalletTransaction = require('./models/WalletTransaction');
const CommissionLedger  = require('./models/CommissionLedger');

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

  // --- Sample Deposits ---
  const demoUser = await User.findOne({ email: accounts.user.email });
  if (demoUser) {
    const existingDeposits = await Deposit.countDocuments({ userId: demoUser._id });
    if (existingDeposits === 0) {
      const now = Date.now();
      await Deposit.insertMany([
        {
          userId: demoUser._id,
          chain: 'TRC20',
          amount: 982.50,
          txHash: '6a15821a7f609ee5a2e3b8f7d4c1982e7a4f609ee5a2e3b8f7d4c1',
          transactionId: 'AUTO-1599753070',
          toAddress: 'TDemoAddress1TRC20NetPayCardPortal',
          blockNumber: 82467588,
          source: 'auto',
          status: 'completed',
          notes: '[Auto-Credited] 1000 USDT detected on TRC20. Block: 82467588. Commission: 17.5 USDT.',
          verifiedOnChain: false,
          creditedAt: new Date(now - 86400000),
          createdAt: new Date(now - 86400000),
        },
        {
          userId: demoUser._id,
          chain: 'TRC20',
          amount: 245.63,
          txHash: '295456fca78ac7e80d8b3a9f1c2d4e5f6a7b8c9d0e1f2a3b4c5d6e',
          transactionId: 'AUTO-A726015525',
          toAddress: 'TDemoAddress1TRC20NetPayCardPortal',
          blockNumber: 82445871,
          source: 'auto',
          status: 'completed',
          notes: '[Auto-Credited] 250 USDT detected on TRC20. Block: 82445871. Commission: 4.375 USDT.',
          verifiedOnChain: false,
          creditedAt: new Date(now - 2 * 86400000),
          createdAt: new Date(now - 2 * 86400000),
        },
        {
          userId: demoUser._id,
          chain: null,
          amount: 50000,
          txHash: `ADMIN-${(now - 3 * 86400000).toString(36).toUpperCase()}`,
          transactionId: 'ADMIN-69F1AF575C6B3',
          source: 'manual',
          status: 'completed',
          notes: 'Manually added by admin.',
          verifiedOnChain: false,
          creditedAt: new Date(now - 3 * 86400000),
          createdAt: new Date(now - 3 * 86400000),
        },
        {
          userId: demoUser._id,
          chain: 'BEP20',
          amount: 100,
          txHash: `bep20_pending_${now.toString(36)}`,
          transactionId: `AUTO-${now.toString(16).toUpperCase().slice(-9)}`,
          toAddress: '0xDemoAddressBEP20NetPayCardPortal',
          blockNumber: null,
          source: 'auto',
          status: 'pending',
          notes: 'Awaiting confirmation on BEP20.',
          verifiedOnChain: false,
          createdAt: new Date(),
        },
      ]);
      console.log('✓ Sample deposits created (4 records: 2 auto TRC20, 1 manual, 1 pending BEP20)');
    } else {
      console.log(`Deposits already exist for demo user (${existingDeposits} records), skipping.`);
    }
  }

  // --- Sample Withdrawals ---
  if (demoUser) {
    const existingWithdrawals = await Withdrawal.countDocuments({ userId: demoUser._id });
    if (existingWithdrawals === 0) {
      const now = Date.now();
      await Withdrawal.insertMany([
        {
          userId: demoUser._id,
          chain: 'TRC20',
          asset: 'USDT',
          amount: 980,
          fee: 20,
          toAddress: 'THGFLz7jvDaz9SEvvthYHKcnnjVFgbs88r',
          txHash: 'd3e4b8377956a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
          status: 'completed',
          processedAt: new Date(now - 5 * 86400000),
          createdAt: new Date(now - 5 * 86400000),
        },
        {
          userId: demoUser._id,
          chain: 'BEP20',
          asset: 'USDT',
          amount: 200,
          fee: 5,
          toAddress: '0x742d35Cc6634C0532925a3b8D4C9B3F8e7Aa1234',
          txHash: null,
          status: 'pending',
          createdAt: new Date(),
        },
      ]);
      console.log('✓ Sample withdrawals created (1 completed TRC20, 1 pending BEP20)');
    } else {
      console.log(`Withdrawals already exist for demo user (${existingWithdrawals} records), skipping.`);
    }
  }

  // --- Sample WalletTransactions ---
  if (demoUser) {
    const demoWallet = await Wallet.findOne({ userId: demoUser._id });
    const existingTxns = await WalletTransaction.countDocuments({ userId: demoUser._id });
    if (existingTxns === 0 && demoWallet) {
      const now = Date.now();
      await WalletTransaction.insertMany([
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'deposit', status: 'completed', amount: 50000,
          transactionId: `ADMIN-${(now - 6 * 86400000).toString(16).toUpperCase().slice(-9)}`,
          notes: 'Manually added by admin.',
          completedAt: new Date(now - 6 * 86400000),
          createdAt: new Date(now - 6 * 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'deposit', status: 'completed', amount: 982.50,
          transactionId: 'AUTO-1599753070',
          chain: 'TRC20', coinName: 'USDT',
          txHash: '6a15821a7f609ee5a2e3b8f7d4c1982e7a4f609ee5a2e3b8f7d4c1',
          notes: '1000 USDT detected on TRC20. Block: 82467588. Commission: 17.5 USDT.',
          completedAt: new Date(now - 86400000),
          createdAt: new Date(now - 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'deposit', status: 'completed', amount: 245.63,
          transactionId: 'AUTO-A726015525',
          chain: 'TRC20', coinName: 'USDT',
          txHash: '295456fca78ac7e80d8b3a9f1c2d4e5f6a7b8c9d0e1f2a3b4c5d6e',
          notes: '250 USDT detected on TRC20. Block: 82445871. Commission: 4.375 USDT.',
          completedAt: new Date(now - 2 * 86400000),
          createdAt: new Date(now - 2 * 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'card_issuance', status: 'completed', amount: 1.00,
          transactionId: `CARD-${(now - 3 * 86400000).toString(16).toUpperCase().slice(-10)}A`,
          notes: 'Virtual card issued: $1.00 deposit + 0.1% fee ($0.00)',
          completedAt: new Date(now - 3 * 86400000),
          createdAt: new Date(now - 3 * 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'card_issuance', status: 'completed', amount: 200.00,
          transactionId: `CARD-${(now - 4 * 86400000).toString(16).toUpperCase().slice(-10)}B`,
          notes: 'Physical card issued: $100.00 deposit + 0% fee ($100.00)',
          completedAt: new Date(now - 4 * 86400000),
          createdAt: new Date(now - 4 * 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'card_topup', status: 'completed', amount: 50.00,
          transactionId: `TOPUP-${(now - 5 * 86400000).toString(16).toUpperCase().slice(-8)}`,
          notes: `Card top-up: $50.00 to card WC202DEMO + 1.5% fee ($0.75)`,
          completedAt: new Date(now - 5 * 86400000),
          createdAt: new Date(now - 5 * 86400000),
        },
        {
          userId: demoUser._id, walletId: demoWallet._id,
          type: 'withdraw', status: 'pending', amount: 100,
          transactionId: `WD-${now.toString(16).toUpperCase().slice(-8)}`,
          chain: 'BEP20',
          depositAddress: '0x742d35Cc6634C0532925a3b8D4C9B3F8e7Aa1234',
          notes: 'Withdrawal request submitted.',
          createdAt: new Date(),
        },
      ]);
      console.log('✓ Sample wallet transactions created (7 records: deposit/card_issuance/card_topup/withdraw)');
    } else {
      const reason = !demoWallet ? 'no wallet found' : `${existingTxns} records exist`;
      console.log(`Wallet transactions skipped (${reason}).`);
    }
  }

  // --- Sample CommissionLedger ---
  if (demoUser) {
    const existingComm = await CommissionLedger.countDocuments({ userId: demoUser._id });
    if (existingComm === 0) {
      const now = Date.now();
      await CommissionLedger.insertMany([
        {
          userId: demoUser._id,
          transactionId: 'AUTO-1599753070',
          type: 'deposit',
          grossAmount: 1000,
          commissionAmount: 17.50,
          netAmount: 982.50,
          rateType: 'percentage',
          rate: 1.75,
          createdAt: new Date(now - 86400000),
        },
        {
          userId: demoUser._id,
          transactionId: 'AUTO-A726015525',
          type: 'deposit',
          grossAmount: 250,
          commissionAmount: 4.375,
          netAmount: 245.625,
          rateType: 'percentage',
          rate: 1.75,
          createdAt: new Date(now - 2 * 86400000),
        },
        {
          userId: demoUser._id,
          transactionId: `CARD-${(now - 3 * 86400000).toString(16).toUpperCase().slice(-10)}A`,
          type: 'card_issuance_virtual',
          grossAmount: 50,
          commissionAmount: 10,
          netAmount: 40,
          rateType: 'fixed',
          rate: 10,
          createdAt: new Date(now - 3 * 86400000),
        },
        {
          userId: demoUser._id,
          transactionId: `CARD-${(now - 4 * 86400000).toString(16).toUpperCase().slice(-10)}B`,
          type: 'card_issuance_physical',
          grossAmount: 100,
          commissionAmount: 50,
          netAmount: 50,
          rateType: 'fixed',
          rate: 50,
          createdAt: new Date(now - 4 * 86400000),
        },
        {
          userId: demoUser._id,
          transactionId: `WD-${(now - 5 * 86400000).toString(16).toUpperCase().slice(-8)}`,
          type: 'withdrawal',
          grossAmount: 1000,
          commissionAmount: 10,
          netAmount: 990,
          rateType: 'percentage',
          rate: 1,
          createdAt: new Date(now - 5 * 86400000),
        },
        {
          userId: demoUser._id,
          transactionId: `TOPUP-${(now - 6 * 86400000).toString(16).toUpperCase().slice(-8)}`,
          type: 'card_topup',
          grossAmount: 200,
          commissionAmount: 3.50,
          netAmount: 196.50,
          rateType: 'percentage',
          rate: 1.75,
          createdAt: new Date(now - 6 * 86400000),
        },
      ]);
      console.log('✓ Sample commission ledger created (6 records)');
    } else {
      console.log(`Commission ledger already exists for demo user (${existingComm} records), skipping.`);
    }
  }

  console.log('\nDone. Accounts:');
  console.log('  User     →  user@demo.com      / Demo@1234      (login at /login)');
  console.log('  Admin    →  admin@demo.com     / Admin@1234     (login at /admin/login)');
  console.log('  Merchant →  merchant@demo.com  / Merchant@1234  (login at /merchant/login)');

  await mongoose.disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
