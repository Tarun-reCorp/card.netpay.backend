// Mark manual pending Deposit rows older than --days (default 30) as
// `rejected` with reason `expired`. Preserves the row for audit; never deletes.
//
//   node scripts/expireStaleDeposits.js                # default 30 days
//   node scripts/expireStaleDeposits.js --days=14
//   node scripts/expireStaleDeposits.js --days=14 --dry-run
//
// Intended as a daily cron. Same logic as POST /admin/deposits/expire-stale
// so a sysadmin without an admin login can still run it.
require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const Deposit = require('../models/Deposit');
const { DEPOSIT_STATUS } = require('../config/statuses');

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');

  const days   = Number(arg('days', 30));
  const dryRun = hasFlag('dry-run');
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be >= 1');

  await mongoose.connect(process.env.MONGO_URI);

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const filter = {
    status:    DEPOSIT_STATUS.PENDING,
    source:    'manual',
    createdAt: { $lt: cutoff },
  };

  if (dryRun) {
    const count = await Deposit.countDocuments(filter);
    console.log(`[expire-stale] DRY RUN — would expire ${count} deposit(s) older than ${days} day(s) (cutoff=${cutoff.toISOString()}).`);
  } else {
    const result = await Deposit.updateMany(filter, {
      $set: {
        status:          DEPOSIT_STATUS.REJECTED,
        rejectedAt:      new Date(),
        rejectionReason: 'expired',
      },
    });
    console.log(`[expire-stale] Expired ${result.modifiedCount}/${result.matchedCount} deposit(s) older than ${days} day(s) (cutoff=${cutoff.toISOString()}).`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[expire-stale] Failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
