const mongoose = require('mongoose');
const { Schema } = mongoose;

// Stores the result of every mutating /api/cards/* call that carried an
// Idempotency-Key header so a retry returns the exact same response and
// never produces a second UQPay charge / second local Card row.
//
// Lookup is by (apiKeyHash, key) so two different merchant keys cannot
// collide on the same client-supplied key string. The TTL index expires
// rows after 24h so the collection cannot grow forever.

const idempotencyRecordSchema = new Schema({
  apiKeyHash:    { type: String, required: true },   // hash of the X-API-Key that owned this call
  key:           { type: String, required: true },   // raw Idempotency-Key from the client
  method:        { type: String, required: true },
  path:          { type: String, required: true },
  payloadHash:   { type: String, required: true },   // sha256 of request body; mismatch ⇒ 409
  responseStatus:{ type: Number, default: null },
  responseBody:  { type: String, default: null },    // JSON-stringified
  inFlight:      { type: Boolean, default: true },   // false once the original request completed
  expiresAt:     { type: Date,   required: true },   // TTL anchor
}, { timestamps: true, collection: 'idempotency_records' });

idempotencyRecordSchema.index({ apiKeyHash: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
