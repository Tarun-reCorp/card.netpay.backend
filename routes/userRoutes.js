const router = require('express').Router();
const authMiddleware = require('../middleware/authMiddleware');
const requireKyc     = require('../middleware/requireKyc');
const profile   = require('../controllers/user/profileController');
const kyc       = require('../controllers/user/kycController');
const wallet    = require('../controllers/user/walletController');
const card      = require('../controllers/user/cardController');

router.use(authMiddleware);

// Profile
router.get('/profile',           profile.getProfile);
router.put('/profile/password',  profile.changePassword);

// KYC — submission/read must remain reachable before approval
router.get('/kyc',          kyc.getKyc);
router.post('/kyc/submit',  kyc.upload.fields([
  { name: 'kycDocFront', maxCount: 1 },
  { name: 'kycDocBack',  maxCount: 1 },
  { name: 'kycSelfie',   maxCount: 1 },
]), kyc.submitKyc);

// Wallet — read-only views stay open so the user can see their state
// (balance, history, status) regardless of KYC. Anything that moves money or
// issues an external resource (address, deposit credit, withdrawal, imports)
// is gated behind `requireKyc`.
router.get('/wallet',                        wallet.getWallet);
router.get('/wallet/payment-methods',        wallet.getPaymentMethods);
router.get('/wallet/cryptrum/deposits/all',  wallet.cryptrumDepositsAll);
router.get('/wallet/cryptrum/deposits',      wallet.cryptrumDeposits);
router.get('/wallet/cryptrum/withdrawals',   wallet.cryptrumWithdrawals);
router.post('/wallet/deposit/address',       requireKyc, wallet.getDepositAddress);
router.post('/wallet/deposit/check',         requireKyc, wallet.checkDeposits);
router.post('/wallet/deposit/manual',        requireKyc, wallet.submitManualDeposit);
router.post('/wallet/deposit/static',        requireKyc, wallet.submitStaticDeposit);
router.get('/wallet/deposit/status/:txHash', wallet.depositStatus);
router.get('/wallet/deposits',               wallet.listDeposits);
router.post('/wallet/withdraw',              requireKyc, wallet.initiateWithdraw);
router.post('/wallet/withdraw/refresh-status', wallet.refreshWithdrawalStatus);
router.get('/wallet/withdrawal/status/:id',  wallet.withdrawalStatus);
router.get('/wallet/history',                wallet.history);
router.post('/wallet/import',                requireKyc, wallet.importWallet);
router.delete('/wallet/import/:id',          requireKyc, wallet.deleteImportedWallet);

// Cards — static routes MUST come before /cards/:id
// Reading the catalogue / fees / availability is fine pre-KYC so the user can
// browse what's on offer; any action that creates or mutates a card requires
// KYC approval.
router.get('/cards',                   card.listCards);
router.get('/cards/products',          card.getProducts);   // UQPay product list
router.get('/cards/fees',              card.getCardFees);   // issuance fee summary
router.get('/cards/physical-available', card.physicalAvailable); // pre-flight check before apply
router.post('/cards/apply',            requireKyc, card.applyCard);

// Cards — dynamic :id routes
router.get('/cards/:id',               card.getCard);
router.get('/cards/:id/transactions',  card.cardTransactions);
router.get('/cards/:id/balance',       card.refreshBalance);
router.post('/cards/:id/deposit',      requireKyc, card.depositCard);
router.post('/cards/:id/withdraw',     requireKyc, card.withdrawFromCard);
router.post('/cards/:id/activate',     requireKyc, card.activateCard);
router.post('/cards/:id/update-pin',   requireKyc, card.updatePin);
router.post('/cards/:id/freeze',       requireKyc, card.freezeCard);
router.post('/cards/:id/unfreeze',     requireKyc, card.unfreezeCard);
router.post('/cards/:id/terminate',    requireKyc, card.terminateCard);
router.post('/cards/:id/reveal',       requireKyc, card.revealCard);

module.exports = router;
