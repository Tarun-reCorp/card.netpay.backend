const router = require('express').Router();
const adminAuth   = require('../middleware/adminAuthMiddleware');
const requireRole = require('../middleware/requireRole');
const authCtrl    = require('../controllers/auth/adminAuthController');
const admin       = require('../controllers/admin/adminController');
const merchantCtrl= require('../controllers/admin/merchantController');
const crypto      = require('../controllers/admin/cryptoAdminController');
const uqpay       = require('../controllers/admin/uqpayController');
const { loginLimiter, twoFactorLimiter } = require('../middleware/rateLimiters');

// Auth (public — 2FA endpoints are challenge-bound by mfaChallengeToken / setupToken)
router.post('/auth/login',      loginLimiter,     authCtrl.login);
router.post('/auth/2fa/verify', twoFactorLimiter, authCtrl.verify2FA);
router.post('/auth/2fa/setup',  twoFactorLimiter, authCtrl.setup2FA);
router.post('/auth/2fa/enable', twoFactorLimiter, authCtrl.enable2FA);

// All routes below require admin token
router.use(adminAuth);

// Dashboard
router.get('/dashboard', admin.dashboard);

// Users
router.get('/users/stats',                    admin.userStats);
router.get('/users',                          admin.listUsers);
router.get('/users/:id',                      admin.getUser);
router.put('/users/:id',                      admin.updateUser);
router.put('/users/:id/block',                admin.blockUser);
router.put('/users/:id/unblock',              admin.unblockUser);
router.put('/users/:id/2fa',                  admin.toggleUser2FA);
router.put('/users/:id/kyc',                  admin.updateKyc);
router.post('/users/:id/add-balance',         requireRole('ops'),   admin.addWalletBalance);
router.post('/users/:id/login-as',            requireRole(),        admin.loginAsUser);          // super-only
router.get('/users/:id/commission',           admin.getUserCommission);
router.put('/users/:id/commission',           requireRole('ops'),   admin.updateUserCommission);
router.get('/users/:id/crypto-addresses',     admin.listUserCryptoAddresses);
router.post('/users/:id/crypto-addresses',    requireRole('ops'),   admin.createUserCryptoAddress);

// Cryptrum passthroughs
router.get('/cryptrum/payment-methods',       admin.cryptrumPaymentMethods);

// Transactions
router.get('/transactions/stats', admin.transactionStats);
router.get('/transactions',       admin.listTransactions);

// Deposits
router.get('/deposits/stats',       admin.depositStats);
router.get('/deposits',             admin.listDeposits);
router.post('/deposits',            requireRole('ops'), admin.createManualDeposit);
router.put('/deposits/:id/approve', requireRole('ops'), admin.approveDeposit);
router.put('/deposits/:id/reject',  requireRole('ops'), admin.rejectDeposit);

// Withdrawals
router.get('/withdrawals/stats',        admin.withdrawalStats);
router.get('/withdrawals',              admin.listWithdrawals);
router.put('/withdrawals/:id/approve',  requireRole('ops'), admin.approveWithdrawal);
router.put('/withdrawals/:id/reject',   requireRole('ops'), admin.rejectWithdrawal);

// Commission
router.get('/commission-settings',  admin.getCommissionSettings);
router.put('/commission-settings',  requireRole('ops'), admin.updateCommissionSettings);
router.get('/commission-history',   admin.commissionHistory);

// Hot Wallets
router.get('/hot-wallets',              admin.listHotWallets);
router.post('/hot-wallets',             admin.createHotWallet);
router.put('/hot-wallets/:id/toggle',   admin.toggleHotWallet);

// Cards
router.get('/cards', admin.listCards);

// Physical Card Numbers
router.get('/physical-card-numbers',                      admin.listPhysicalCardNumbers);
router.post('/physical-card-numbers',                     admin.addPhysicalCardNumbers);
router.delete('/physical-card-numbers/:id',               admin.deletePhysicalCardNumber);
router.put('/physical-card-numbers/:id/assign-merchant',  admin.assignCardToMerchant);
router.put('/physical-card-numbers/:id/pre-assign-user',  admin.preAssignUser);
router.post('/physical-card-numbers/:id/mark-used',       admin.markCardNumberUsed);
router.post('/physical-card-numbers/:id/mark-available',  admin.markCardNumberAvailable);

// Wallet service logs
router.get('/wallet-service-logs', admin.walletServiceLogs);
router.get('/uqpay-api-logs',      admin.uqpayApiLogs);

// Admin users (for 2FA management) — super-only: toggling another admin's
// 2FA can lock them out, and listing admins exposes account metadata.
router.get('/admins',                  requireRole(), admin.listAdmins);
router.put('/admins/:id/2fa',          requireRole(), admin.toggleAdmin2FA);

// Merchants
router.get('/merchants/stats',              merchantCtrl.merchantStats);
router.get('/merchants',                    merchantCtrl.listMerchants);
router.get('/merchants/:id',                merchantCtrl.getMerchant);
router.post('/merchants',                   requireRole('ops'), merchantCtrl.createMerchant);
router.put('/merchants/:id',                requireRole('ops'), merchantCtrl.updateMerchant);
router.put('/merchants/:id/2fa',            requireRole('ops'), merchantCtrl.toggleMerchant2FA);
router.put('/merchants/:id/activate',       requireRole('ops'), merchantCtrl.activateMerchant);
router.put('/merchants/:id/deactivate',     requireRole('ops'), merchantCtrl.deactivateMerchant);
router.post('/merchants/:id/login-as',      requireRole(),      merchantCtrl.loginAsMerchant);  // super-only
router.get('/merchants/:id/commission',     merchantCtrl.getMerchantCommission);
router.put('/merchants/:id/commission',     requireRole('ops'), merchantCtrl.updateMerchantCommission);

// Crypto admin
router.get('/crypto/dashboard',                     crypto.dashboard);
router.put('/crypto/chains/:chain/toggle',          crypto.toggleChain);
router.get('/crypto/hot-wallets',                   crypto.listHotWallets);
router.put('/crypto/hot-wallets/:id/toggle',        crypto.toggleHotWallet);
router.get('/crypto/admin-wallets',                 crypto.listAdminWallets);
router.post('/crypto/admin-wallets',                crypto.createAdminWallet);
router.put('/crypto/admin-wallets/:id',             crypto.updateAdminWallet);
router.delete('/crypto/admin-wallets/:id',          crypto.deleteAdminWallet);
router.get('/crypto/deposits',                      crypto.listDeposits);
router.get('/crypto/withdrawals',                   crypto.listWithdrawals);
router.put('/crypto/withdrawals/:id/approve',       crypto.approveWithdrawal);
router.put('/crypto/withdrawals/:id/reject',        crypto.rejectWithdrawal);
router.get('/crypto/gas-treasury',                  crypto.gasTreasury);
router.get('/crypto/gas-logs',                      crypto.gasLogs);
router.get('/crypto/service-logs',                  crypto.walletServiceLogs);

// UQPay
router.get('/uqpay/products',                  uqpay.listProducts);
router.get('/uqpay/cardholders/uqpay-list',    uqpay.listCardholdersUQPay);
router.post('/uqpay/cardholders',              uqpay.createCardholder);
router.get('/uqpay/cardholders',               uqpay.listCardholders);
router.get('/uqpay/cardholders/:id',           uqpay.getCardholder);
router.post('/uqpay/cardholders/:id',          uqpay.updateCardholder);
router.get('/uqpay/cards/stats',               uqpay.getCardStats);
router.get('/uqpay/cards/uqpay-list',          uqpay.listCardsUQPay);
router.post('/uqpay/cards',                    uqpay.createCard);
router.get('/uqpay/cards',                     uqpay.listCards);
router.get('/uqpay/cards/:id',                 uqpay.getUqpayCard);
router.post('/uqpay/cards/:id',                uqpay.updateCard);

module.exports = router;
