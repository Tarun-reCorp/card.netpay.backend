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
    deposits:            (d.deposit_list?.data || []).map(row => ({
      uniqueId:     row.unique_id,
      txHash:       row.thash,
      amount:       row.amount,
      usdtAmount:   row.usdt_amount,
      status:       row.deposit_status,    // 0 = pending, 1 = confirmed
      name:         row.name,
      networkName:  row.network_name,
      createdAt:    row.created_at,
    })),
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
async function createWithdraw({ referenceId, paymentMethodId, amount, toAddress } = {}) {
  if (!referenceId)              throw new Error('referenceId is required');
  if (paymentMethodId == null)   throw new Error('paymentMethodId is required');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error('amount must be a positive number');
  }
  if (!toAddress)                throw new Error('toAddress is required');

  let data;
  try {
    const res = await client().post('/withdraw', {
      reference_id:      String(referenceId),
      payment_method_id: Number(paymentMethodId),
      amount:            Number(amount),
      to_address:        String(toAddress),
    }, { headers: { 'Content-Type': 'application/json' } });
    data = res.data;
  } catch (err) { rethrow(err, 'withdraw'); }
  ensureSuccess(data, 'withdraw');
  return {
    withdrawCode: data.withdraw_code,
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
    withdrawals: (d.data || []).map(row => ({
      code:               row.code,
      referenceId:        row.reference_id,
      amount:             row.amount,
      withdrawableAmount: row.withdrawable_amount,
      toAddress:          row.to_address,
      txHash:             row.thash,
      status:             row.status,        // 0 = pending, 1 = completed
      txHashVerified:     row.thash_verify === 1,
      name:               row.name,
      networkName:        row.network_name,
      createdAt:          row.created_at,
    })),
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
};
