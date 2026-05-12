const router = require('express').Router();
const adminAuth   = require('../middleware/adminAuthMiddleware');
const authCtrl    = require('../controllers/auth/adminAuthController');
const admin       = require('../controllers/admin/adminController');
const merchantCtrl= require('../controllers/admin/merchantController');
const crypto      = require('../controllers/admin/cryptoAdminController');
const uqpay       = require('../controllers/admin/uqpayController');

// Auth
router.post('/auth/login', authCtrl.login);

// All routes below require admin token
router.use(adminAuth);

// Dashboard
router.get('/dashboard', admin.dashboard);

// Users
router.get('/users/stats',                    admin.userStats);
router.get('/users',                          admin.listUsers);
router.get('/users/:id',                      admin.getUser);
router.put('/users/:id/block',                admin.blockUser);
router.put('/users/:id/unblock',              admin.unblockUser);
router.put('/users/:id/kyc',                  admin.updateKyc);
router.post('/users/:id/add-balance',         admin.addWalletBalance);
router.post('/users/:id/login-as',            admin.loginAsUser);
router.get('/users/:id/commission',           admin.getUserCommission);
router.put('/users/:id/commission',           admin.updateUserCommission);

// Transactions
router.get('/transactions/stats', admin.transactionStats);
router.get('/transactions',       admin.listTransactions);

// Deposits
router.get('/deposits/stats',       admin.depositStats);
router.get('/deposits',             admin.listDeposits);
router.post('/deposits',            admin.createManualDeposit);
router.put('/deposits/:id/approve', admin.approveDeposit);
router.put('/deposits/:id/reject',  admin.rejectDeposit);

// Withdrawals
router.get('/withdrawals/stats',        admin.withdrawalStats);
router.get('/withdrawals',              admin.listWithdrawals);
router.put('/withdrawals/:id/approve',  admin.approveWithdrawal);
router.put('/withdrawals/:id/reject',   admin.rejectWithdrawal);

// Commission
router.get('/commission-settings',  admin.getCommissionSettings);
router.put('/commission-settings',  admin.updateCommissionSettings);
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

// Merchants
router.get('/merchants/stats',              merchantCtrl.merchantStats);
router.get('/merchants',                    merchantCtrl.listMerchants);
router.get('/merchants/:id',                merchantCtrl.getMerchant);
router.post('/merchants',                   merchantCtrl.createMerchant);
router.put('/merchants/:id',                merchantCtrl.updateMerchant);
router.put('/merchants/:id/activate',       merchantCtrl.activateMerchant);
router.put('/merchants/:id/deactivate',     merchantCtrl.deactivateMerchant);
router.post('/merchants/:id/login-as',      merchantCtrl.loginAsMerchant);
router.get('/merchants/:id/commission',     merchantCtrl.getMerchantCommission);
router.put('/merchants/:id/commission',     merchantCtrl.updateMerchantCommission);

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
