const router = require('express').Router();
const merchantAuth    = require('../middleware/merchantAuthMiddleware');
const authCtrl        = require('../controllers/auth/merchantAuthController');
const dashboard       = require('../controllers/merchant/merchantDashboardController');
const cards           = require('../controllers/merchant/merchantCardController');
const physicalCards   = require('../controllers/merchant/physicalCardController');
const users           = require('../controllers/merchant/merchantUserController');

// Auth
router.post('/auth/login', authCtrl.login);

// All routes below require merchant token
router.use(merchantAuth);

router.get('/dashboard', dashboard.dashboard);

// Cards
router.get('/cards', cards.listCards);

// Physical cards
router.get('/physical-cards',                 physicalCards.listPhysicalCards);
router.put('/physical-cards/:id/assign-user', physicalCards.assignToUser);
router.put('/physical-cards/:id/unassign',    physicalCards.unassignFromUser);

// Users
router.get('/users', users.listUsers);

module.exports = router;
