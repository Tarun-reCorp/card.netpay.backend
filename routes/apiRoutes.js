const router = require('express').Router();
const apiKey = require('../middleware/apiKeyMiddleware');
const cardApi = require('../controllers/api/cardApiController');

router.use(apiKey);

router.get('/health',                            cardApi.health);
router.post('/cards/holder',                     cardApi.createHolder);
router.post('/cards/issue',                      cardApi.issueCard);
router.get('/cards/holder/:holderId',            cardApi.listCards);
router.get('/cards/:cardId/balance',             cardApi.getBalance);
router.get('/cards/:cardId/transactions',        cardApi.getTransactions);
router.post('/cards/:cardId/load',               cardApi.loadCard);
router.post('/cards/:cardId/unload',             cardApi.unloadCard);
router.post('/cards/:cardId/freeze',             cardApi.freezeCard);
router.post('/cards/:cardId/unfreeze',           cardApi.unfreezeCard);
router.post('/cards/:cardId/terminate',          cardApi.terminateCard);
router.get('/cards/:cardId/reveal',              cardApi.revealCard);

module.exports = router;
