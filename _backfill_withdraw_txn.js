require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Withdrawal = require('./models/Withdrawal');
const WalletTransaction = require('./models/WalletTransaction');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const withdrawals = await Withdrawal.find({ status: { $ne: 'pending' } });
  let linked = 0, updated = 0, unmatched = 0;

  for (const w of withdrawals) {
    let txn = await WalletTransaction.findOne({ referenceId: w._id.toString(), type: 'withdraw' });
    if (!txn) {
      txn = await WalletTransaction.findOne({
        userId: w.userId, type: 'withdraw', amount: w.amount, status: 'pending',
      }).sort({ createdAt: -1 });
      if (txn) linked++;
    }
    if (!txn) { unmatched++; console.log(`✗ no txn for withdrawal ${w._id} (${w.status}, $${w.amount})`); continue; }

    txn.referenceId = txn.referenceId || w._id.toString();
    txn.status = w.status;       // approved / rejected / processing / completed / failed
    if (['approved', 'completed'].includes(w.status)) txn.completedAt = txn.completedAt || w.updatedAt || new Date();
    if (w.status === 'rejected') txn.notes = w.rejectionReason || txn.notes;
    await txn.save();
    updated++;
    console.log(`✓ ${w._id} → txn ${txn.transactionId} (${w.status})`);
  }

  console.log(`\nDone. Updated: ${updated}, newly linked: ${linked}, unmatched: ${unmatched}`);
  process.exit(0);
})();
