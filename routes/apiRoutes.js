const router = require('express').Router();
const apiKey = require('../middleware/apiKeyMiddleware');
const cardApi = require('../controllers/api/cardApiController');

router.use(apiKey);

router.get('/health',                                  cardApi.health);
router.post('/cards/holder',                           cardApi.createHolder);
router.post('/cards/issue',                            cardApi.issueCard);
router.get('/cards/:wasabiCardId/balance',             cardApi.getBalance);
router.get('/cards/holder/:holderId',                  cardApi.listCards);
router.get('/cards/:wasabiCardId/transactions',        cardApi.getTransactions);
router.post('/cards/:wasabiCardId/load',               cardApi.loadCard);
router.post('/cards/:wasabiCardId/unload',             cardApi.unloadCard);
router.post('/cards/:wasabiCardId/freeze',             cardApi.freezeCard);
router.post('/cards/:wasabiCardId/unfreeze',           cardApi.unfreezeCard);
router.post('/cards/:wasabiCardId/terminate',          cardApi.terminateCard);
router.get('/cards/:wasabiCardId/reveal',              cardApi.revealCard);

module.exports = router;
