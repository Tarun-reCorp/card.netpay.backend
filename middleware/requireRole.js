// Per-route admin role gate. Use after adminAuthMiddleware so req.admin is set.
//
//   router.post('/users/:id/add-balance',
//     requireRole('super', 'ops'),
//     admin.addWalletBalance,
//   );
//
// A request from an admin whose role isn't in the allowed list returns 403
// — and the attempt is structured-logged so an audit run can spot probing.
//
// `super` is granted implicitly for every check unless explicitly excluded,
// so a super-admin can hit every endpoint without enumerating roles.

function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  // super always allowed unless caller explicitly opts out by passing
  // an allowed list that omits 'super' AND includes '!super'.
  const excludeSuper = allowed.has('!super');
  if (excludeSuper) allowed.delete('!super');
  if (!excludeSuper) allowed.add('super');

  return (req, res, next) => {
    const role = req.admin?.role;
    if (!role) {
      return res.status(401).json({ success: false, message: 'Unauthenticated admin' });
    }
    if (!allowed.has(role)) {
      console.warn('[requireRole] DENY adminId=%s role=%s path=%s required=%j',
        req.admin._id, role, req.originalUrl, Array.from(allowed));
      return res.status(403).json({ success: false, message: 'Insufficient privileges for this action' });
    }
    next();
  };
}

module.exports = requireRole;
