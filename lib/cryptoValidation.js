// Address + amount validation for crypto operations.
//
// All withdrawal-path mutations route through this module so the rules are
// stated in one place. Adding a chain means adding one regex line below.

const EVM_RE  = /^0x[a-fA-F0-9]{40}$/;
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// Map of canonical Cryptrum network_name (uppercased) → regex it should match.
// Falls back via networkType (EVM / TRON) when an unknown chain shows up.
const CHAIN_REGEX = {
  BEP20:     EVM_RE,
  ERC20:     EVM_RE,
  POLYGON:   EVM_RE,
  ARBITRUM:  EVM_RE,
  BASE:      EVM_RE,
  AVALANCHE: EVM_RE,
  OPTIMISM:  EVM_RE,
  BNB:       EVM_RE,   // BNB on BSC — same EVM format
  TRC20:     TRON_RE,
  TRON:      TRON_RE,
};

const FAMILY_REGEX = {
  EVM:  EVM_RE,
  TRON: TRON_RE,
};

// Money rules — these are platform-wide caps; per-network caps can be added
// later by passing { min, max } through validateAmount.
const DEFAULT_MIN_AMOUNT = 1;            // USDT
const DEFAULT_MAX_AMOUNT = 1_000_000;    // hard ceiling
const MAX_DECIMAL_PLACES = 2;            // USDT cents — Cryptrum settles in 8 dp but ledger is 2 dp.

/**
 * Validate a money amount.
 *   - Must be a finite positive number
 *   - Must be within [min, max]
 *   - Must have at most MAX_DECIMAL_PLACES decimals
 * Returns { ok: true, amount } (rounded to 2 dp) or { ok: false, error }.
 */
function validateAmount(input, opts = {}) {
  const min = opts.min ?? DEFAULT_MIN_AMOUNT;
  const max = opts.max ?? DEFAULT_MAX_AMOUNT;
  const n   = Number(input);

  if (!Number.isFinite(n))  return { ok: false, error: 'Amount must be a number' };
  if (n <= 0)               return { ok: false, error: 'Amount must be positive' };
  if (n < min)              return { ok: false, error: `Minimum amount is $${min}` };
  if (n > max)              return { ok: false, error: `Maximum amount is $${Number(max).toLocaleString()}` };

  // Precision check — refuse silly long decimals that won't survive USDT rounding.
  const s = String(input).trim();
  const dot = s.indexOf('.');
  if (dot >= 0 && (s.length - dot - 1) > MAX_DECIMAL_PLACES) {
    return { ok: false, error: `Amount can have at most ${MAX_DECIMAL_PLACES} decimal places` };
  }

  return { ok: true, amount: Math.round(n * 100) / 100 };
}

/**
 * Validate a destination address against a chain / family.
 *
 *   validateAddress(addr, { chain: 'TRC20' })           → uses CHAIN_REGEX
 *   validateAddress(addr, { family: 'EVM' })            → uses FAMILY_REGEX
 *   validateAddress(addr, { chain: '???', family: 'EVM' })  → chain unknown, falls back to family
 *
 * Returns { ok: true, address } (trimmed) or { ok: false, error }.
 */
function validateAddress(input, { chain, family } = {}) {
  if (typeof input !== 'string')   return { ok: false, error: 'Recipient address is required' };
  const a = input.trim();
  if (!a)                          return { ok: false, error: 'Recipient address is required' };
  if (a.length > 100)              return { ok: false, error: 'Address looks too long' };

  let re = chain  ? CHAIN_REGEX[String(chain).toUpperCase()]   : null;
  if (!re) re = family ? FAMILY_REGEX[String(family).toUpperCase()] : null;
  if (!re) {
    // Unknown chain & family — accept any non-empty short string, but flag.
    // Caller should treat the lack of `re` as a soft warning.
    return { ok: true, address: a, warning: `Address format not validated for ${chain || family || 'this network'}` };
  }
  if (!re.test(a)) {
    return { ok: false, error: `Invalid address format for ${chain || family}` };
  }
  return { ok: true, address: a };
}

/**
 * Derive an address family from a Cryptrum payment-methods row.
 * The provider returns `network_type_name` like "EVM" or "TRON"; falls back
 * to the network name if missing.
 */
function familyForMethod(method) {
  if (!method) return null;
  if (method.networkType) {
    const f = String(method.networkType).toUpperCase();
    if (FAMILY_REGEX[f]) return f;
  }
  const name = String(method.networkName || '').toUpperCase();
  if (CHAIN_REGEX[name] === TRON_RE) return 'TRON';
  if (CHAIN_REGEX[name] === EVM_RE)  return 'EVM';
  return null;
}

module.exports = {
  EVM_RE,
  TRON_RE,
  CHAIN_REGEX,
  FAMILY_REGEX,
  DEFAULT_MIN_AMOUNT,
  DEFAULT_MAX_AMOUNT,
  MAX_DECIMAL_PLACES,
  validateAmount,
  validateAddress,
  familyForMethod,
};
