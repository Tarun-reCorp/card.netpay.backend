const router = require('express').Router();
const auth = require('../controllers/auth/authController');
const authMiddleware = require('../middleware/authMiddleware');
const { loginLimiter, twoFactorLimiter, forgotPasswordLimiter } = require('../middleware/rateLimiters');

router.post('/register',              auth.register);
router.post('/login',                 loginLimiter,         auth.login);
router.post('/google',                loginLimiter,         auth.googleAuth);
router.post('/2fa/verify',            twoFactorLimiter,     auth.verify2FA);
router.post('/2fa/setup-forced',      twoFactorLimiter,     auth.setup2FAForced);
router.post('/2fa/enable-forced',     twoFactorLimiter,     auth.enable2FAForced);
router.get('/2fa/setup',              authMiddleware,       auth.setup2FA);
router.post('/2fa/enable',            authMiddleware,       auth.enable2FA);
router.post('/forgot-password',       forgotPasswordLimiter,auth.forgotPassword);
router.post('/reset-password',        forgotPasswordLimiter,auth.resetPassword);
router.get('/merchant-brand/:tag',    auth.getMerchantBrand);

module.exports = router;
