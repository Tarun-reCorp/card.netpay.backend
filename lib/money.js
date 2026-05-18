// Single source of truth for monetary arithmetic.
//
// Why this file exists:
//   The codebase stores money as JavaScript Number (IEEE-754 double). Different
//   call sites rounded with `Math.round(x*100)/100`, `.toFixed(2)`, raw float,
//   or not at all. Mixing strategies on the same wallet introduces drift over
//   time and lets a single bad input (NaN, Infinity, string, object) poison
//   balances forever. All money math must go through this module so the
//   rounding and validation are identical everywhere.
//
// Conventions:
//   - 2 decimal-place currency assumed (USDT / USD).
//   - Round half-up via Math.round (matches the dominant pre-existing
//     pattern — switching to banker's now would shift historical totals).
//   - Every helper THROWS on a non-finite input or a non-finite result.
//     Controllers catch the throw and return a clean 4xx/5xx response. This
//     guarantees no wallet write ever stores NaN/Infinity.

const MAX_MONEY = 1_000_000_000; // 1B per single value — sanity ceiling

class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

function toNumberStrict(value, label = 'value') {
  if (value === null || value === undefined || value === '') {
    throw new MoneyError(`${label} is required`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new MoneyError(`${label} must be a finite number`);
  }
  if (Math.abs(n) > MAX_MONEY) {
    throw new MoneyError(`${label} exceeds safe maximum (${MAX_MONEY})`);
  }
  return n;
}

// Round a finite number to 2 decimal places. Throws on non-finite input.
function toMoney(value, label = 'amount') {
  const n = toNumberStrict(value, label);
  const rounded = Math.round(n * 100) / 100;
  if (!Number.isFinite(rounded)) {
    throw new MoneyError(`${label} produced a non-finite rounded value`);
  }
  return rounded;
}

function addMoney(a, b) {
  return toMoney(toNumberStrict(a, 'a') + toNumberStrict(b, 'b'), 'sum');
}

function subMoney(a, b) {
  return toMoney(toNumberStrict(a, 'a') - toNumberStrict(b, 'b'), 'difference');
}

function mulMoney(a, b) {
  return toMoney(toNumberStrict(a, 'a') * toNumberStrict(b, 'b'), 'product');
}

// True if value is a finite positive money amount within MAX_MONEY.
function isPositiveMoney(value) {
  try {
    const n = toNumberStrict(value, 'value');
    return n > 0;
  } catch {
    return false;
  }
}

// True if value is finite and >= 0 (zero allowed, e.g. for fees).
function isNonNegativeMoney(value) {
  try {
    const n = toNumberStrict(value, 'value');
    return n >= 0;
  } catch {
    return false;
  }
}

// Compute a commission fee given a base amount, rate, and rateType.
// rateType: 'percentage' (rate is 0–100) | 'fixed' (rate is the fee itself).
// A non-finite/negative stored rate falls to 0 instead of poisoning callers.
function commissionAmount(base, rate, rateType) {
  const baseN = toNumberStrict(base, 'base');
  if (baseN < 0) throw new MoneyError('base must be non-negative');
  const rateN = Number.isFinite(Number(rate)) && Number(rate) >= 0 ? Number(rate) : 0;
  const type  = rateType === 'fixed' ? 'fixed' : 'percentage';
  const raw   = type === 'fixed' ? rateN : (baseN * rateN) / 100;
  return toMoney(raw, 'fee');
}

module.exports = {
  toMoney,
  addMoney,
  subMoney,
  mulMoney,
  isPositiveMoney,
  isNonNegativeMoney,
  commissionAmount,
  MoneyError,
  MAX_MONEY,
};
