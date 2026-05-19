const axios = require('axios');
const FormData = require('form-data');

const ENDPOINT = (process.env.CRYPTRUM_API_URL || '').replace(/\/+$/, '');
const API_KEY  = process.env.CRYPTRUM_API_KEY || '';

function client() {
  if (!ENDPOINT) throw new Error('CRYPTRUM_API_URL is not configured');
  if (!API_KEY)  throw new Error('CRYPTRUM_API_KEY is not configured');
  return axios.create({
    baseURL: ENDPOINT,
    timeout: 15_000,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
  });
}

// Surface a clean error with `.status` set to the upstream HTTP code so the
// caller can choose 502 / 401 / 400 etc. when forwarding to the API client.
function rethrow(err, fallbackMsg) {
  const status = err.response?.status;
  const body   = err.response?.data;
  const upstreamMsg =
    (body && (body.msg || body.message || body.error)) ||
    (typeof body === 'string' ? body : null);
  const message =
    status === 401
      ? 'Cryptrum rejected the API key (401). Check CRYPTRUM_API_KEY value.'
      : upstreamMsg
        ? `Cryptrum ${status || ''}: ${upstreamMsg}`.trim()
        : (err.message || fallbackMsg || 'Cryptrum request failed');
  const e = new Error(message);
  e.status = status || 502;
  e.upstream = body;
  throw e;
}

function ensureSuccess(data, label) {
  if (!data || data.status !== true) {
    const e = new Error(data?.msg || data?.message || `Cryptrum ${label}: non-success response`);
    e.status = 502;
    throw e;
  }
}

// Cryptrum's `deposit_status` is a numeric phase, not a boolean.
//   0 = Pending                          (chain has not seen the tx yet)
//   1 = Completed                        (credit-able — funds collected)
//   2 = Queued for Verification          (txHash submitted, awaiting confs)
//   3 = Hash Verified (Awaiting Gas)     (confs done; gas top-up pending)
//   4 = Gas Transferred (Awaiting Collect) (gas funded; sweep pending)
//   5 = Failed                           (terminal — will not complete)
//
// Only phase 1 is credit-able. 0/2/3/4 are in-flight and should re-poll.
// 5 is terminal-failed and should stop polling.
const CRYPTRUM_DEPOSIT_STATUS = Object.freeze({
  0: { code: 'pending',                          label: 'Pending',                          confirmed: false, terminal: false },
  1: { code: 'completed',                        label: 'Completed',                        confirmed: true,  terminal: true  },
  2: { code: 'queued-for-verification',          label: 'Queued for Verification',          confirmed: false, terminal: false },
  3: { code: 'hash-verified-awaiting-gas',       label: 'Hash Verified (Awaiting Gas)',     confirmed: false, terminal: false },
  4: { code: 'gas-transferred-awaiting-collect', label: 'Gas Transferred (Awaiting Collect)', confirmed: false, terminal: false },
  5: { code: 'failed',                           label: 'Failed',                           confirmed: false, terminal: true  },
});

function describeDepositStatus(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && CRYPTRUM_DEPOSIT_STATUS[n]) {
    return { raw: n, ...CRYPTRUM_DEPOSIT_STATUS[n] };
  }
  return { raw, code: 'unknown', label: `Unknown (${raw})`, confirmed: false, terminal: false };
}

// Cryptrum's `withdraw_list.status` is also a numeric phase. Eight values:
//   0 = Pending                          (received, not yet picked up)
//   1 = Completed                        (terminal — sent and confirmed)
//   2 = Queued for Verification          (in queue for hash-verification)
//   3 = Processing Transfer              (signing / broadcasting)
//   4 = Energy Transferred               (Tron-specific gas / energy step)
//   5 = Awaiting Blockchain Confirmation (broadcast, waiting confs)
//   6 = Unsuccessful                     (terminal — refund the user)
//   7 = Cancelled                        (terminal — refund the user)
//
// `completed` ⇒ release the local row as `completed`.
// `failed`/`cancelled` ⇒ release the local row as `failed`/`rejected` AND
// credit the user's wallet back (Cryptrum still holds the funds because the
// on-chain payout did not succeed).
// Anything else is in-flight; the caller re-polls.
const CRYPTRUM_WITHDRAW_STATUS = Object.freeze({
  0: { code: 'pending',                         label: 'Pending',                          completed: false, failed: false, cancelled: false, terminal: false },
  1: { code: 'completed',                       label: 'Completed',                        completed: true,  failed: false, cancelled: false, terminal: true  },
  2: { code: 'queued-for-verification',         label: 'Queued for Verification',          completed: false, failed: false, cancelled: false, terminal: false },
  3: { code: 'processing-transfer',             label: 'Processing Transfer',              completed: false, failed: false, cancelled: false, terminal: false },
  4: { code: 'energy-transferred',              label: 'Energy Transferred',               completed: false, failed: false, cancelled: false, terminal: false },
  5: { code: 'awaiting-blockchain-confirmation', label: 'Awaiting Blockchain Confirmation', completed: false, failed: false, cancelled: false, terminal: false },
  6: { code: 'unsuccessful',                    label: 'Unsuccessful',                     completed: false, failed: true,  cancelled: false, terminal: true  },
  7: { code: 'cancelled',                       label: 'Cancelled',                        completed: false, failed: false, cancelled: true,  terminal: true  },
});

function describeWithdrawStatus(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && CRYPTRUM_WITHDRAW_STATUS[n]) {
    return { raw: n, ...CRYPTRUM_WITHDRAW_STATUS[n] };
  }
  return { raw, code: 'unknown', label: `Unknown (${raw})`, completed: false, failed: false, cancelled: false, terminal: false };
}

function normalizeMethod(r, imageBaseUrl) {
  return {
    id:              r.id,
    userPaymentId:   r.user_payment_method_id,
    name:            r.name,
    networkName:     r.network_name,
    networkType:     r.network_type_name,
    networkTypeId:   r.network_type_id,
    chainId:         r.chain_id,
    logoUrl:         r.logo ? `${imageBaseUrl}${r.logo}` : null,
    depositEnabled:  r.deposit_status === 1 || r.deposit_status === true,
    withdrawEnabled: r.withdraw_status === 1 || r.withdraw_status === true,
    usdRate:         r.usd_rate,
    eurRate:         r.eur_rate,
    inrRate:         r.inr_rate,
    aedRate:         r.aed_rate,
  };
}

// GET /all-payment-methods — flat map of { networkName: cryptoSymbol }.
async function getAllPaymentMethods() {
  try {
    const { data } = await client().get('/all-payment-methods');
    ensureSuccess(data, 'all-payment-methods');
    return data.data || {};
  } catch (err) { rethrow(err, 'all-payment-methods'); }
}

// GET /payment-methods?type=deposit|withdraw — paginated, with rates + statuses.
async function getPaymentMethods(type = 'deposit') {
  const safeType = type === 'withdraw' ? 'withdraw' : 'deposit';
  let data;
  try {
    ({ data } = await client().get('/payment-methods', { params: { type: safeType } }));
  } catch (err) { rethrow(err, 'payment-methods'); }
  ensureSuccess(data, 'payment-methods');
  const imageBaseUrl = (data.payment_method_image_url || '').replace(/\/+$/, '') + '/';
  const rows = (data.data && Array.isArray(data.data.data)) ? data.data.data : [];
  return { items: rows.map(r => normalizeMethod(r, imageBaseUrl)), imageBaseUrl };
}

// POST /fetch-address (multipart) — issues or returns the user's address.
async function fetchAddress(uniqueId, paymentMethodId) {
  if (!uniqueId) throw new Error('uniqueId is required');
  if (paymentMethodId == null) throw new Error('paymentMethodId is required');
  const form = new FormData();
  form.append('unique_id', String(uniqueId));
  form.append('payment_method_id', String(paymentMethodId));
  let data;
  try {
    const res = await client().post('/fetch-address', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    data = res.data;
  } catch (err) { rethrow(err, 'fetch-address'); }
  ensureSuccess(data, 'fetch-address');
  if (!data.data?.address) {
    const e = new Error('Cryptrum returned no address');
    e.status = 502;
    throw e;
  }
  return { address: data.data.address };
}

// GET /deposit-list — paginated deposit history for a (uniqueId × paymentMethodId).
// opts: { uniqueId, paymentMethodId, balanceSync = 1, fromDate, toDate, thash, depositStatus, page }
async function getDepositList(opts = {}) {
  if (!opts.uniqueId) throw new Error('uniqueId is required');
  if (opts.paymentMethodId == null) throw new Error('paymentMethodId is required');
  const params = {
    balance_sync:      opts.balanceSync ?? 1,
    unique_id:         String(opts.uniqueId),
    payment_method_id: String(opts.paymentMethodId),
  };
  if (opts.fromDate)       params.from_date       = opts.fromDate;
  if (opts.toDate)         params.to_date         = opts.toDate;
  if (opts.thash)          params.thash           = opts.thash;
  if (opts.depositStatus != null) params.deposit_status = opts.depositStatus;
  if (opts.page)           params.page            = opts.page;

  let data;
  try {
    ({ data } = await client().get('/deposit-list', { params }));
  } catch (err) { rethrow(err, 'deposit-list'); }
  ensureSuccess(data, 'deposit-list');
  const d = data.data || {};
  return {
    address:             d.address || null,
    totalDepositAmount:  d.total_deposit_amount,
    verifiedDeposit:     d.verified_deposit,
    totalDeposit:        d.total_deposit,
    deposits:            (d.deposit_list?.data || []).map(row => {
      const phase = describeDepositStatus(row.deposit_status);
      return {
        uniqueId:     row.unique_id,
        txHash:       row.thash,
        amount:       row.amount,
        usdtAmount:   row.usdt_amount,
        // Raw numeric phase from Cryptrum (0..5) — see CRYPTRUM_DEPOSIT_STATUS.
        status:       phase.raw,
        // Stable kebab-case identifier — safe for switch / UI keys.
        statusCode:   phase.code,
        // Human-readable label — surface to the user as-is.
        statusLabel:  phase.label,
        // True only for phase 1 (the only credit-able phase).
        confirmed:    phase.confirmed,
        // True for phases 1 and 5 — caller should stop polling.
        terminal:     phase.terminal,
        toAddress:    row.to_address || row.address || null,
        fromAddress:  row.from_address || null,
        name:         row.name,
        networkName:  row.network_name,
        createdAt:    row.created_at,
      };
    }),
    pagination: {
      currentPage: d.deposit_list?.current_page,
      perPage:     d.deposit_list?.per_page,
      total:       d.deposit_list?.total,
      lastPage:    d.deposit_list?.last_page,
      nextPageUrl: d.deposit_list?.next_page_url,
      prevPageUrl: d.deposit_list?.prev_page_url,
    },
  };
}

// POST /withdraw (raw JSON) — submits a withdrawal to an external address.
// args: { referenceId, paymentMethodId, amount, toAddress }
// Returns { withdrawCode, message } on success.
//
// This is the last barrier before money leaves the platform. Even though
// callers validate upstream, every assumption is re-checked here so a buggy
// caller can never push a malformed payload to Cryptrum.
async function createWithdraw({ referenceId, paymentMethodId, amount, toAddress } = {}) {
  // referenceId — required, string-coercible, capped length so we don't get 422'd
  if (referenceId == null || String(referenceId).trim() === '') {
    throw new Error('referenceId is required');
  }
  const refId = String(referenceId).trim();
  if (refId.length > 64) throw new Error('referenceId too long (max 64 chars)');

  // paymentMethodId — strictly a positive integer
  const pmId = Number(paymentMethodId);
  if (!Number.isInteger(pmId) || pmId <= 0) {
    throw new Error('paymentMethodId must be a positive integer');
  }

  // amount — positive finite, capped ceiling, sane decimals
  const amt = Number(amount);
  if (!Number.isFinite(amt))   throw new Error('amount must be a number');
  if (amt <= 0)                throw new Error('amount must be positive');
  if (amt > 1_000_000)         throw new Error('amount exceeds platform ceiling');
  const rounded = Math.round(amt * 1e8) / 1e8;  // clip to 8 dp — Cryptrum settles at this precision
  if (rounded <= 0)            throw new Error('amount rounds to zero');

  // toAddress — non-empty string, sane length, no whitespace inside
  if (typeof toAddress !== 'string' || !toAddress.trim()) {
    throw new Error('toAddress is required');
  }
  const addr = toAddress.trim();
  if (addr.length < 20 || addr.length > 100) throw new Error('toAddress length out of range');
  if (/\s/.test(addr)) throw new Error('toAddress contains whitespace');

  let data;
  try {
    const res = await client().post('/withdraw', {
      reference_id:      refId,
      payment_method_id: pmId,
      amount:            rounded,
      to_address:        addr,
    }, { headers: { 'Content-Type': 'application/json' } });
    data = res.data;
  } catch (err) { rethrow(err, 'withdraw'); }
  ensureSuccess(data, 'withdraw');
  // Cryptrum's docs show the create response as "6971bf7f9f780." (trailing
  // dot/whitespace) but /withdraw-list returns it without. Normalize so the
  // saved code matches what we'll later filter on.
  const raw = data.withdraw_code;
  const code = raw == null ? null : String(raw).trim().replace(/[.\s]+$/, '');
  return {
    withdrawCode: code,
    message:      data.msg,
  };
}

// GET /withdraw-list — paginated withdrawal history; all filters optional.
// opts: { referenceId, paymentMethodId, thash, withdrawStatus, thashVerify,
//         toAddress, code, fromDate, toDate, page }
async function getWithdrawList(opts = {}) {
  const params = {};
  if (opts.referenceId)             params.reference_id      = opts.referenceId;
  if (opts.paymentMethodId != null) params.payment_method_id = opts.paymentMethodId;
  if (opts.thash)                   params.thash             = opts.thash;
  if (opts.withdrawStatus != null)  params.withdraw_status   = opts.withdrawStatus;
  if (opts.thashVerify != null)     params.thash_verify      = opts.thashVerify;
  if (opts.toAddress)               params.to_address        = opts.toAddress;
  if (opts.code)                    params.code              = opts.code;
  if (opts.fromDate)                params.from_date         = opts.fromDate;
  if (opts.toDate)                  params.to_date           = opts.toDate;
  if (opts.page)                    params.page              = opts.page;

  let data;
  try {
    ({ data } = await client().get('/withdraw-list', { params }));
  } catch (err) { rethrow(err, 'withdraw-list'); }
  ensureSuccess(data, 'withdraw-list');
  const d = data.data || {};
  return {
    withdrawals: (d.data || []).map(row => {
      const phase = describeWithdrawStatus(row.status);
      return {
        code:               row.code,
        referenceId:        row.reference_id,
        amount:             row.amount,
        withdrawableAmount: row.withdrawable_amount,
        toAddress:          row.to_address,
        txHash:             row.thash,
        // Raw numeric phase (0..7) — see CRYPTRUM_WITHDRAW_STATUS.
        status:             phase.raw,
        statusCode:         phase.code,
        statusLabel:        phase.label,
        completed:          phase.completed,
        failed:             phase.failed,
        cancelled:          phase.cancelled,
        terminal:           phase.terminal,
        txHashVerified:     row.thash_verify === 1,
        name:               row.name,
        networkName:        row.network_name,
        createdAt:          row.created_at,
      };
    }),
    pagination: {
      currentPage: d.current_page,
      perPage:     d.per_page,
      total:       d.total,
      lastPage:    d.last_page,
      nextPageUrl: d.next_page_url,
      prevPageUrl: d.prev_page_url,
    },
  };
}

module.exports = {
  getAllPaymentMethods,
  getPaymentMethods,
  fetchAddress,
  getDepositList,
  createWithdraw,
  getWithdrawList,
  CRYPTRUM_DEPOSIT_STATUS,
  describeDepositStatus,
  CRYPTRUM_WITHDRAW_STATUS,
  describeWithdrawStatus,
};
