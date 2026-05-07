const router = require('express').Router();

router.use('/auth',     require('./authRoutes'));
router.use('/user',     require('./userRoutes'));
router.use('/admin',    require('./adminRoutes'));
router.use('/merchant', require('./merchantRoutes'));
router.use('/cards',    require('./apiRoutes'));

module.exports = router;
