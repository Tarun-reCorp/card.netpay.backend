const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

class WasabiService {
  constructor() {
    this.baseUrl = (process.env.WASABI_API_URL || '').replace(/\/$/, '');
    this.apiKey  = process.env.WASABI_API_KEY  || '';
    this.privKey = process.env.WASABI_API_SECRET || '';
    this._lastError = null;
  }

  _pem(key, type) {
    key = key.trim();
    if (key.includes('-----BEGIN')) return key;
    const lines = [];
    for (let i = 0; i < key.length; i += 64) lines.push(key.slice(i, i + 64));
    return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
  }

  _sign(body) {
    if (!this.privKey) return '';
    for (const type of ['PRIVATE KEY', 'RSA PRIVATE KEY']) {
      try {
        const s = crypto.createSign('RSA-SHA256');
        s.update(body);
        return s.sign(this._pem(this.privKey, type), 'base64');
      } catch {}
    }
    return '';
  }

  decryptRsa(encrypted) {
    if (!encrypted || !this.privKey) return null;
    for (const type of ['PRIVATE KEY', 'RSA PRIVATE KEY']) {
      try {
        const key = crypto.createPrivateKey(this._pem(this.privKey, type));
        return crypto.privateDecrypt(
          { key, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(encrypted, 'base64')
        ).toString('utf8');
      } catch {}
    }
    return null;
  }

  async _post(endpoint, params = {}) {
    const body = Object.keys(params).length === 0 ? '{}' : JSON.stringify(params);
    const sig   = this._sign(body);
    this._lastError = null;
    try {
      const res = await axios.post(this.baseUrl + endpoint, params, {
        headers: {
          'Content-Type'    : 'application/json',
          'X-WSB-API-KEY'   : this.apiKey,
          'X-WSB-SIGNATURE' : sig,
        },
        timeout: 15000,
      });
      const json = res.data;
      if (!json.success) this._lastError = json.msg || 'API request failed';
      return json;
    } catch (e) {
      if (e.response) {
        this._lastError = e.response.data?.msg || 'HTTP ' + e.response.status;
        return e.response.data || { success: false };
      }
      this._lastError = e.message;
      return { success: false, msg: e.message };
    }
  }

  async uploadKycFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const sig = this._sign('{}');
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('category', 'card');
      const res = await axios.post(
        this.baseUrl + '/merchant/core/mcb/common/file/upload',
        form,
        {
          headers: { ...form.getHeaders(), 'X-WSB-API-KEY': this.apiKey, 'X-WSB-SIGNATURE': sig },
          timeout: 30000,
        }
      );
      return res.data?.success ? (res.data.data?.fileId || null) : null;
    } catch {
      return null;
    }
  }

  lastError() { return this._lastError; }

  // ── Card Types ────────────────────────────────────────────────────────────

  async getCardTypes() {
    const res = await this._post('/merchant/core/mcb/card/v2/cardTypes');
    return res.success ? (res.data || []) : [];
  }

  // ── Holder ────────────────────────────────────────────────────────────────

  async createHolder(params) {
    const res = await this._post('/merchant/core/mcb/card/holder/v2/create', params);
    if (res.success) return res.data || {};
    const msg = (res.msg || '').toLowerCase();
    const existing = ['already exists', 'under review', 'reviewed successfully', 'do not submit again', 'duplicate order', 'order number'];
    if (existing.some(p => msg.includes(p))) { this._lastError = null; return res.data || {}; }
    this._lastError = res.msg || 'Failed to create holder';
    return null;
  }

  async findHolderByOrderNo(merchantOrderNo) {
    const res = await this._post('/merchant/core/mcb/card/holder/query', { pageNum: 1, pageSize: 10, merchantOrderNo });
    for (const row of res.data?.records || []) {
      if (this._isRejected(row)) continue;
      const id = row.holderId || row.id;
      if (id) return String(id);
    }
    return null;
  }

  async findHolderByEmail(email, cardTypeId) {
    const res = await this._post('/merchant/core/mcb/card/holder/query', { pageNum: 1, pageSize: 10, email });
    const rows = res.data?.records || [];
    // First pass: exact cardTypeId match
    for (const row of rows) {
      if (this._isRejected(row)) continue;
      if (cardTypeId && Number(row.cardTypeId) === Number(cardTypeId)) {
        const id = row.holderId || row.id; if (id) return String(id);
      }
    }
    // Second pass: any non-rejected
    for (const row of rows) {
      if (this._isRejected(row)) continue;
      const id = row.holderId || row.id; if (id) return String(id);
    }
    return null;
  }

  _isRejected(row) {
    const bad = ['rejected', 'failed', 'closed', 'cancelled', 'canceled'];
    return bad.includes((row.status || row.kycStatus || '').toLowerCase());
  }

  // ── Card Operations ───────────────────────────────────────────────────────

  async createCard(params) {
    const res = await this._post('/merchant/core/mcb/card/v2/createCard', params);
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }

  async getCardInfo(cardNo) {
    const res = await this._post('/merchant/core/mcb/card/info', { cardNo });
    return res.success ? (res.data || null) : null;
  }

  async getSensitiveInfo(cardNo) {
    const res = await this._post('/merchant/core/mcb/card/sensitive', { cardNo });
    if (!res.success) { this._lastError = res.msg; return null; }
    const d = res.data || {};
    return {
      cardNumber : this.decryptRsa(d.cardNumber),
      cvv        : this.decryptRsa(d.cvv),
      expireDate : this.decryptRsa(d.expireDate),
    };
  }

  async getCardTransactions(cardNo, filters = {}) {
    const params = { cardNo, pageNum: 1, pageSize: 20, ...filters };
    const res = await this._post('/merchant/core/mcb/card/transaction', params);
    return res.success ? (res.data || { total: 0, records: [] }) : { total: 0, records: [] };
  }

  async depositToCard(cardNo, merchantOrderNo, amount) {
    const res = await this._post('/merchant/core/mcb/card/deposit', { cardNo, merchantOrderNo, amount });
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }

  async withdrawFromCard(cardNo, merchantOrderNo, amount) {
    const res = await this._post('/merchant/core/mcb/card/withdraw', { cardNo, merchantOrderNo, amount });
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }

  async freezeCard(cardNo) {
    const res = await this._post('/merchant/core/mcb/card/v2/freeze', { cardNo, merchantOrderNo: 'FRZ' + Date.now() });
    if (!res.success) { this._lastError = res.msg; return null; }
    const d = res.data || {};
    if ((d.status || '').toLowerCase() === 'fail') { this._lastError = res.msg || 'Freeze failed on provider side'; return null; }
    return d;
  }

  async unfreezeCard(cardNo) {
    const res = await this._post('/merchant/core/mcb/card/v2/unfreeze', { cardNo, merchantOrderNo: 'UFZ' + Date.now() });
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }

  async cancelCard(cardNo) {
    const res = await this._post('/merchant/core/mcb/card/cancel', { cardNo, merchantOrderNo: 'CAN' + Date.now() });
    if (!res.success) { this._lastError = res.msg; return null; }
    const d = res.data || {};
    if ((d.status || '').toLowerCase() === 'fail') { this._lastError = res.msg || 'Cancel failed on provider side'; return null; }
    return d;
  }

  async activatePhysicalCard(cardNo, merchantOrderNo, pin, activeCode) {
    const res = await this._post('/merchant/core/mcb/card/physicalCard/activeCard', { cardNo, merchantOrderNo, pin, activeCode });
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }

  async updatePhysicalCardPin(cardNo, merchantOrderNo, pin) {
    const res = await this._post('/merchant/core/mcb/card/physicalCard/updatePin', { cardNo, merchantOrderNo, pin });
    if (!res.success) { this._lastError = res.msg; return null; }
    return res.data || {};
  }
}

module.exports = WasabiService;
