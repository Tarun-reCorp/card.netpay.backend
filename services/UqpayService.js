const axios  = require('axios');
const crypto = require('crypto');
const UqpayToken = require('../models/UqpayToken');
const UqpayCardholder = require('../models/UqpayCardholder');
const UqpayCard = require('../models/UqpayCard');
const UqpayApiLog = require('../models/UqpayApiLog');

const BASE_URL = process.env.UQPAY_API_URL || 'https://api-sandbox.uqpaytech.com/api/v1';
const TOKEN_BUFFER_SECONDS = 60;
const MAX_LOG_BODY_BYTES = 16 * 1024;

// Paths whose request/response bodies carry PAN, CVV, PIN, or other PCI-sensitive
// material. These bodies are NEVER persisted to uqpay_api_logs — only the path,
// status, and duration are recorded.
const SENSITIVE_PATH_PATTERNS = [
  /\/secure(?:\?|$)/i,         // GET /issuing/cards/{id}/secure  → PAN+CVV+expiry
  /\/cards\/pin(?:\?|$)/i,     // POST /issuing/cards/pin         → cleartext PIN
  /\/connect\/token(?:\?|$)/i, // POST /connect/token             → auth_token
];

function isSensitivePath(url) {
  if (!url) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(url));
}

function stringifyForLog(value) {
  if (value == null) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > MAX_LOG_BODY_BYTES ? s.slice(0, MAX_LOG_BODY_BYTES) + '…[truncated]' : s;
  } catch {
    return String(value).slice(0, MAX_LOG_BODY_BYTES);
  }
}

function relPath(url) {
  if (!url) return '';
  return url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) || '/' : url;
}

async function writeApiLog(entry) {
  try {
    await UqpayApiLog.create(entry);
  } catch (e) {
    console.error('[UqpayApiLog] write failed:', e.message);
  }
}

// Single chokepoint for every UQPay HTTP call. Times the call, captures the raw
// request body and response body (or the error payload on failure), and writes
// one row to uqpay_api_logs.
async function request(method, url, { data, params, headers } = {}) {
  const start = process.hrtime.bigint();
  const sensitive = isSensitivePath(url);
  const requestPayload = sensitive
    ? '[REDACTED-SENSITIVE]'
    : stringifyForLog(data ?? (params ? { _query: params } : null));
  let httpStatus = null;
  let responseBody = null;
  let success = false;
  let errorMessage = null;
  try {
    const res = await axios.request({ method, url, data, params, headers });
    httpStatus = res.status;
    responseBody = sensitive ? '[REDACTED-SENSITIVE]' : stringifyForLog(res.data);
    success = res.status >= 200 && res.status < 300;
    return res;
  } catch (err) {
    httpStatus = err.response?.status ?? null;
    responseBody = sensitive
      ? '[REDACTED-SENSITIVE]'
      : stringifyForLog(err.response?.data ?? null);
    errorMessage = err.response?.data?.message
      || err.response?.data?.error
      || err.message
      || 'Request failed';
    success = false;
    throw err;
  } finally {
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    writeApiLog({
      method: String(method || 'GET').toUpperCase(),
      path: relPath(url),
      requestPayload,
      responseBody,
      httpStatus,
      success,
      errorMessage,
      durationMs,
    });
  }
}

// Headers used only for token generation
function getConnectHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key':   process.env.UQPAY_API_KEY,
    'x-client-id': process.env.UQPAY_CLIENT_ID,
  };
}

// Headers used for all authenticated UQPay API calls
function getApiHeaders(authToken) {
  return {
    'Content-Type': 'application/json',
    'x-auth-token': authToken,
  };
}

// ── Token Management ──────────────────────────────────────────────────────────

// In-process mutex for token refresh. When the cached DB token has expired and
// N concurrent requests race to refresh, they all `await` the same Promise so
// UQPay's /connect/token is called exactly once. Without this guard a single
// expiry triggers a stampede of refresh calls, UQPay rate-limits us, and the
// updateMany({}, {is_active:false}) → create() pair races into either zero or
// multiple "active" rows.
let _refreshPromise = null;

async function generateToken() {
  console.log('[UQPay] Generating new auth token...');
  let response;
  try {
    response = await request('POST', `${BASE_URL}/connect/token`, { data: {}, headers: getConnectHeaders() });
  } catch (e) {
    console.error('[UQPay] Token generation failed:', JSON.stringify(e.response?.data || e.message));
    throw e;
  }

  const { auth_token, expired_at } = response.data;

  await UqpayToken.updateMany({}, { is_active: false });
  const token = await UqpayToken.create({ auth_token, expired_at, is_active: true });

  console.log(`[UQPay] Token generated. Expires at: ${new Date(expired_at * 1000).toISOString()}`);
  return token;
}

async function refreshTokenOnce() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      return await generateToken();
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

async function getValidToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stored = await UqpayToken.findOne({ is_active: true }).sort({ createdAt: -1 });

  if (stored && stored.expired_at - TOKEN_BUFFER_SECONDS > nowSeconds) {
    return stored.auth_token;
  }

  const fresh = await refreshTokenOnce();
  return fresh.auth_token;
}

// ── Cardholder ────────────────────────────────────────────────────────────────

async function createCardholder(input) {
  const { userId = null, adminId = null, ...payload } = input;
  const token = await getValidToken();

  const { data } = await request('POST', `${BASE_URL}/issuing/cardholders`, {
    data: payload,
    headers: { ...getApiHeaders(token), 'x-idempotency-key': crypto.randomUUID() },
  });

  return UqpayCardholder.create({
    userId, adminId,
    cardholder_id: data.cardholder_id,
    cardholder_status: data.cardholder_status,
    ...payload,
  });
}

async function listCardholdersFromUQPay({ page_size = 10, page_number = 1 } = {}) {
  const token = await getValidToken();
  const response = await request('GET', `${BASE_URL}/issuing/cardholders`, {
    params: { page_size, page_number },
    headers: getApiHeaders(token),
  });
  return response.data;
}

async function getCardholder(cardholder_id) {
  const token = await getValidToken();
  const response = await request('GET', `${BASE_URL}/issuing/cardholders/${cardholder_id}`, {
    headers: getApiHeaders(token),
  });
  return response.data;
}

async function updateCardholder(cardholder_id, { country_code, email, phone_number, date_of_birth, gender, nationality, document_type, document }) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();

  const payload = {};
  if (country_code)  payload.country_code  = country_code;
  if (email)         payload.email         = email;
  if (phone_number)  payload.phone_number  = phone_number;
  if (date_of_birth) payload.date_of_birth = date_of_birth;
  if (gender)        payload.gender        = gender;
  if (nationality)   payload.nationality   = nationality;
  if (document_type) payload.document_type = document_type;
  if (document)      payload.document      = document;

  const response = await request('POST', `${BASE_URL}/issuing/cardholders/${cardholder_id}`, {
    data: payload,
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });

  return response.data;
}

// ── Products ──────────────────────────────────────────────────────────────────

async function getProducts({ page_size = 10, page_number = 1 } = {}) {
  const token = await getValidToken();

  const response = await request('GET', `${BASE_URL}/issuing/products`, {
    params: { page_size, page_number },
    headers: getApiHeaders(token),
  });

  return response.data;
}

// ── Card ──────────────────────────────────────────────────────────────────────

async function createCard({
  card_currency, cardholder_id, card_product_id, cardholderId, userId = null, adminId = null,
  card_limit, name_on_card, spending_controls, risk_controls, metadata,
  usage_type, auto_cancel_trigger, expiry_at, cardholder_required_fields,
}) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();

  const payload = { card_currency, cardholder_id, card_product_id };

console.log("payload" , payload);


  if (card_limit !== undefined)        payload.card_limit                 = card_limit;
  if (name_on_card)                    payload.name_on_card               = name_on_card;
  if (spending_controls)               payload.spending_controls          = spending_controls;
  if (risk_controls)                   payload.risk_controls              = risk_controls;
  if (metadata)                        payload.metadata                   = metadata;
  if (usage_type)                      payload.usage_type                 = usage_type;
  if (auto_cancel_trigger)             payload.auto_cancel_trigger        = auto_cancel_trigger;
  if (expiry_at)                       payload.expiry_at                  = expiry_at;
  if (cardholder_required_fields)      payload.cardholder_required_fields = cardholder_required_fields;



  console.log('[UQPay] Creating card with payload:', JSON.stringify(payload));


  const response = await request('POST', `${BASE_URL}/issuing/cards`, {
    data: payload,
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });

  const { card_order_id, card_id, cardholder_id: resp_cardholder_id, card_status, order_status, create_time } = response.data;

  const card = await UqpayCard.create({
    cardholderId,
    userId,
    adminId,
    card_order_id,
    card_id,
    cardholder_id: resp_cardholder_id || cardholder_id,
    card_status,
    order_status,
    card_currency,
    card_product_id,
    create_time: create_time ? new Date(create_time) : new Date(),
  });

  console.log(`[UQPay] Card created: ${card_id} (${card_status})`);
  return card;
}

// Assigns a pre-issued physical card (by card_number) to a cardholder.
// POST /issuing/cards/assign
async function assignCard({
  cardholder_id, card_number, card_currency, card_mode,
  card_product_id, cardholderId, userId = null, adminId = null,
}) {
  const token = await getValidToken();

  const payload = {
    cardholder_id: String(cardholder_id || '').trim(),
    card_number  : String(card_number || '').replace(/\D/g, ''),
    card_currency: String(card_currency || '').trim().toUpperCase(),
    card_mode    : String(card_mode || '').trim().toUpperCase(),
  };

  console.log('[UQPay] assignCard payload →', JSON.stringify(payload));

  const { data } = await request('POST', `${BASE_URL}/issuing/cards/assign`, {
    data: payload,
    headers: { ...getApiHeaders(token), 'x-idempotency-key': crypto.randomUUID() },
  }).catch(err => {
    console.error('[UQPay] assignCard rejected by provider →',
      'status=', err.response?.status,
      'body=', JSON.stringify(err.response?.data));
    throw err;
  });

  return UqpayCard.create({
    cardholderId, userId, adminId,
    card_order_id : data.card_order_id,
    card_id       : data.card_id,
    cardholder_id : data.cardholder_id || cardholder_id,
    card_status   : data.card_status,
    order_status  : data.order_status,
    card_currency,
    card_product_id: card_product_id || 'physical',
    create_time   : data.create_time ? new Date(data.create_time) : new Date(),
  });
}

async function getCardInfo(card_id) {
  const token = await getValidToken();
  const response = await request('GET', `${BASE_URL}/issuing/cards/${card_id}`, {
    headers: getApiHeaders(token),
  });
  return response.data;
}

async function listCardsFromUQPay({ page_size = 10, page_number = 1 } = {}) {
  const token = await getValidToken();
  const response = await request('GET', `${BASE_URL}/issuing/cards`, {
    params: { page_size, page_number },
    headers: getApiHeaders(token),
  });
  return response.data;
}

async function updateCard(card_id, payload) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();
  const response = await request('POST', `${BASE_URL}/issuing/cards/${card_id}`, {
    data: payload,
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });
  return response.data;
}

async function rechargeCard(card_id, amount) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();
  const response = await request('POST', `${BASE_URL}/issuing/cards/${card_id}/recharge`, {
    data: { amount },
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });
  return response.data;
}

async function withdrawCard(card_id, amount) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();
  const response = await request('POST', `${BASE_URL}/issuing/cards/${card_id}/withdraw`, {
    data: { amount },
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });
  return response.data;
}

async function getCardOrders(card_id, params = {}) {
  const token = await getValidToken();
  const response = await request('GET', `${BASE_URL}/issuing/cards/${card_id}/order`, {
    params,
    headers: getApiHeaders(token),
  });
  return response.data;
}

// NOTE: UQPay v1.6 does not expose a separate "authorizations" endpoint —
// authorizations are surfaced via `/issuing/cards/{id}/order` with order_type filter.
// Kept as a thin alias so existing callers keep compiling.
async function getCardAuthorizations(card_id, params = {}) {
  return getCardOrders(card_id, { ...params, order_type: 'AUTHORIZATION' });
}

async function resetCardPin(card_id, pin) {
  const token          = await getValidToken();
  const idempotencyKey = crypto.randomUUID();
  const response = await request('POST', `${BASE_URL}/issuing/cards/pin`, {
    data: { card_id, pin },
    headers: { ...getApiHeaders(token), 'x-idempotency-key': idempotencyKey },
  });
  return response.data;
}

// ── Card Sensitive Data ───────────────────────────────────────────────────────

async function getCardSensitiveInfo(card_id) {
  const token = await getValidToken();

  const response = await request('GET', `${BASE_URL}/issuing/cards/${card_id}/secure`, {
    headers: getApiHeaders(token),
  });

  return response.data;
}

// ── Card Status Update (freeze / unfreeze / cancel) ───────────────────────────

async function updateCardStatus(card_id, card_status, update_reason = '') {
  const token = await getValidToken();

  const response = await request('POST', `${BASE_URL}/issuing/cards/${card_id}/status`, {
    data: { card_status, update_reason },
    headers: { ...getApiHeaders(token), 'x-idempotency-key': crypto.randomUUID() },
  });

  return response.data;
}

module.exports = {
  getValidToken,
  createCardholder, listCardholdersFromUQPay, getCardholder, updateCardholder,
  getProducts,
  createCard, assignCard, getCardInfo, listCardsFromUQPay, updateCard,
  rechargeCard, withdrawCard, getCardOrders, getCardAuthorizations, resetCardPin,
  updateCardStatus, getCardSensitiveInfo,
};
