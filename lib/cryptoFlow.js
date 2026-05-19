// Pure helpers for the crypto deposit + withdrawal flow.
//
// Everything here is a stateless, synchronous function. No DB, no HTTP, no
// global state. That makes the file the safe place to put logic that must
// behave consistently between the controller paths and the smoke tests in
// scripts/testCryptoFlow.js — both import the same helpers.

// Address family for case-handling. EVM addresses are case-insensitive
// (mixed-case is the EIP-55 checksum, not a different address); Tron is
// strictly case-sensitive.
function familyForNetwork(networkType, networkName) {
  if (String(networkType || '').toUpperCase() === 'TRON') return 'TRON';
  if (String(networkName || '').toUpperCase() === 'TRC20') return 'TRON';
  return 'EVM';
}

// Compare two addresses using the right case-policy for the family.
function addressesMatch(a, b, family) {
  if (!a || !b) return false;
  return family === 'EVM' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Verify that a remote Cryptrum deposit row really belongs to (this user,
// this cached address). Returns { ok: boolean, reason?: string } — the reason
// is used as the skip code in the API response.
function verifyDepositOwnership(dep, userIdStr, cached) {
  if (dep.uniqueId != null && String(dep.uniqueId) !== userIdStr) {
    return { ok: false, reason: 'wrong-user' };
  }
  if (dep.toAddress && cached?.address) {
    const family = familyForNetwork(cached.networkType, cached.networkName);
    if (!addressesMatch(dep.toAddress, cached.address, family)) {
      return { ok: false, reason: 'address-mismatch' };
    }
  }
  return { ok: true };
}

// Money math — fee rounding for the commission tiers. Always returns
// non-negative, 2-dp rounded. Mirrors what controllers were computing inline.
function computeCommission(commSetting, grossAmount) {
  if (!commSetting) return { fee: 0, net: round2(grossAmount) };
  const fee = commSetting.rateType === 'percentage'
    ? round2(grossAmount * commSetting.rate / 100)
    : Number(commSetting.rate) || 0;
  const net = Math.max(0, round2(grossAmount - fee));
  return { fee, net };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Filter a list of user cached addresses to the ones we want to reconcile
// against Cryptrum. The optional paymentMethodId filter is what the original
// /deposit/check used — passed through unchanged. With no filter, every
// cached address is returned so the caller can check across all networks.
function selectAddressesToCheck(cryptoAddresses, paymentMethodId) {
  const all = Array.isArray(cryptoAddresses) ? cryptoAddresses : [];
  if (paymentMethodId == null) return all;
  return all.filter(a => a.paymentMethodId === paymentMethodId);
}

module.exports = {
  familyForNetwork,
  addressesMatch,
  verifyDepositOwnership,
  computeCommission,
  selectAddressesToCheck,
  round2,
};
