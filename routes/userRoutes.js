const router = require('express').Router();
const authMiddleware = require('../middleware/authMiddleware');
const profile   = require('../controllers/user/profileController');
const kyc       = require('../controllers/user/kycController');
const wallet    = require('../controllers/user/walletController');
const card      = require('../controllers/user/cardController');

router.use(authMiddleware);

// Profile
router.get('/profile',           profile.getProfile);
router.put('/profile/password',  profile.changePassword);

// KYC
router.get('/kyc',          kyc.getKyc);
router.post('/kyc/submit',  kyc.upload.fields([
  { name: 'kycDocFront', maxCount: 1 },
  { name: 'kycDocBack',  maxCount: 1 },
  { name: 'kycSelfie',   maxCount: 1 },
]), kyc.submitKyc);

// Wallet
router.get('/wallet',                        wallet.getWallet);
router.get('/wallet/deposit/coins',          wallet.getSupportedCoins);
router.post('/wallet/deposit/address',       wallet.getDepositAddress);
router.post('/wallet/deposit/manual',        wallet.submitManualDeposit);
router.get('/wallet/deposit/status/:txHash', wallet.depositStatus);
router.get('/wallet/deposits',               wallet.listDeposits);
router.post('/wallet/withdraw',              wallet.initiateWithdraw);
router.get('/wallet/withdrawal/status/:id',  wallet.withdrawalStatus);
router.get('/wallet/history',                wallet.history);
router.post('/wallet/import',                wallet.importWallet);
router.delete('/wallet/import/:id',          wallet.deleteImportedWallet);

// Cards — static routes MUST come before /cards/:id
router.get('/cards',                   card.listCards);
router.get('/cards/check-holder',      card.checkHolder);   // duplicate email/mobile check
router.get('/cards/fees',              card.getCardFees);   // issuance fee summary
router.post('/cards/apply',            card.applyCard);

// Cards — dynamic :id routes
router.get('/cards/:id',               card.getCard);
router.get('/cards/:id/transactions',  card.cardTransactions);
router.get('/cards/:id/balance',       card.refreshBalance);
router.post('/cards/:id/topup',        card.topupCard);
router.post('/cards/:id/withdraw',     card.withdrawFromCard);
router.post('/cards/:id/activate',     card.activateCard);
router.post('/cards/:id/update-pin',   card.updatePin);
router.post('/cards/:id/freeze',       card.freezeCard);
router.post('/cards/:id/unfreeze',     card.unfreezeCard);
router.post('/cards/:id/terminate',    card.terminateCard);
router.post('/cards/:id/reveal',       card.revealCard);

module.exports = router;
