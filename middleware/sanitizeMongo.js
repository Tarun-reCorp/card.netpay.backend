// Sanitizes incoming JSON-shaped data against MongoDB query-operator injection.
//
// Why this exists:
//   Mongoose/MongoDB treat `{ $ne: null }` and `{ $gt: '' }` as operators when
//   they appear as a value in a filter. If a controller does
//   `User.findOne({ email: req.body.email })` and a caller sends
//   `{ "email": { "$ne": null } }`, the lookup degrades into "find any user".
//   Stripping any property whose key starts with `$` or contains `.` makes the
//   filter behave as plain equality regardless of how the controller wires it.
//
// Behavior:
//   - Recursively walks plain objects and arrays.
//   - Deletes keys starting with `$` or containing `.` (Mongo dotted paths
//     could also reach into nested fields).
//   - Leaves primitives, Buffers, and Dates alone.
//   - Mutates in place on req.body and req.params.
//   - req.query in Express is a getter — values are reassigned key by key on
//     the existing object so the property descriptor isn't broken.

function sanitizeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = sanitizeValue(value[i]);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete value[key];
      continue;
    }
    value[key] = sanitizeValue(value[key]);
  }
  return value;
}

function sanitizeMongo(req, _res, next) {
  if (req.body)   sanitizeValue(req.body);
  if (req.params) sanitizeValue(req.params);
  if (req.query) {
    // req.query may be a frozen getter in newer Express; mutate keys in place
    // rather than reassigning the object.
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('$') || key.includes('.')) {
        delete req.query[key];
        continue;
      }
      req.query[key] = sanitizeValue(req.query[key]);
    }
  }
  next();
}

module.exports = sanitizeMongo;
