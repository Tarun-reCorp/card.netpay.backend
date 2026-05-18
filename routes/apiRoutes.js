const router = require('express').Router();
const apiKey = require('../middleware/apiKeyMiddleware');
const cardApi = require('../controllers/api/cardApiController');
const { merchantApiLimiter } = require('../middleware/rateLimiters');
const idempotency = require('../middleware/idempotency');

router.use(apiKey);
// Tight per-API-key rate limit so a leaked key cannot burst thousands of
// UQPay-billable mutations before rotation.
router.use(merchantApiLimiter);

router.get('/health',                            cardApi.health);
router.post('/cards/holder',                     idempotency, cardApi.createHolder);
router.post('/cards/issue',                      idempotency, cardApi.issueCard);
router.get('/cards/holder/:holderId',            cardApi.listCards);
router.get('/cards/:cardId/balance',             cardApi.getBalance);
router.get('/cards/:cardId/transactions',        cardApi.getTransactions);
router.post('/cards/:cardId/load',               idempotency, cardApi.loadCard);
router.post('/cards/:cardId/unload',             idempotency, cardApi.unloadCard);
router.post('/cards/:cardId/freeze',             idempotency, cardApi.freezeCard);
router.post('/cards/:cardId/unfreeze',           idempotency, cardApi.unfreezeCard);
router.post('/cards/:cardId/terminate',          idempotency, cardApi.terminateCard);
router.get('/cards/:cardId/reveal',              cardApi.revealCard);

module.exports = router;
