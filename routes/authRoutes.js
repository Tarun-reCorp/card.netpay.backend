const router = require('express').Router();
const auth = require('../controllers/auth/authController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/register',        auth.register);
router.post('/login',           auth.login);
router.post('/2fa/verify',      auth.verify2FA);
router.get('/2fa/setup',        authMiddleware, auth.setup2FA);
router.post('/2fa/enable',      authMiddleware, auth.enable2FA);
router.post('/forgot-password', auth.forgotPassword);
router.post('/reset-password',  auth.resetPassword);

module.exports = router;
