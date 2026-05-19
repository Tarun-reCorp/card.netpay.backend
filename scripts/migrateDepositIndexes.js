// One-shot migration: swap Deposit dedup index from (chain, txHash) → (txHash).
//
// Why: EVM chains share addresses + HD keys, so the same on-chain tx can
// surface under multiple Cryptrum payment_method_ids. The old (chain, txHash)
// unique key allowed the same txHash to be credited once per chain. EIP-155
// guarantees txHash is globally unique per signed tx, so keying on txHash
// alone closes that double-credit hole.
//
// Safe to re-run: each step is guarded by an existence/value check.
//
//   node scripts/migrateDepositIndexes.js
//
require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.collection('deposits');

  // 1. Refuse to migrate if duplicate txHashes already exist — those would
  //    be the very cross-chain double-credits this fix is meant to prevent;
  //    operator must reconcile them by hand before the unique index can build.
  const dupes = await col.aggregate([
    { $match: { txHash: { $type: 'string', $ne: null } } },
    { $group: { _id: '$txHash', count: { $sum: 1 }, ids: { $push: '$_id' }, chains: { $addToSet: '$chain' } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (dupes.length) {
    console.error(`[migrate] Found ${dupes.length} txHash(es) with duplicate Deposit rows:`);
    for (const d of dupes) {
      console.error(`  txHash=${d._id}  rows=${d.count}  chains=${d.chains.join(',')}  ids=${d.ids.join(',')}`);
    }
    console.error('[migrate] Reconcile duplicates before re-running. No changes were made.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  // 2. Drop the old compound unique index if present.
  const existing = await col.indexes();
  const oldIdx = existing.find(i => i.name === 'uniq_chain_txhash');
  if (oldIdx) {
    console.log('[migrate] Dropping old index uniq_chain_txhash …');
    await col.dropIndex('uniq_chain_txhash');
  } else {
    console.log('[migrate] Old index uniq_chain_txhash not present — skipping drop.');
  }

  // 3. Build the new unique partial index on txHash.
  const newIdx = existing.find(i => i.name === 'uniq_txhash');
  if (!newIdx) {
    console.log('[migrate] Creating new unique index uniq_txhash …');
    await col.createIndex(
      { txHash: 1 },
      {
        unique: true,
        partialFilterExpression: { txHash: { $type: 'string' } },
        name: 'uniq_txhash',
      },
    );
  } else {
    console.log('[migrate] New index uniq_txhash already present — skipping create.');
  }

  // 4. Make sure the supporting userId+createdAt index is in place too.
  const userByDate = existing.find(i => i.name === 'userId_1_createdAt_-1');
  if (!userByDate) {
    console.log('[migrate] Creating index userId+createdAt …');
    await col.createIndex({ userId: 1, createdAt: -1 });
  }

  console.log('[migrate] Done.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate] Failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
