// tracking.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const tc = require('../controllers/tracking.controller');
router.post('/start', protect, tc.startTracking);
router.post('/update', protect, tc.updateLocation);
router.post('/stop', protect, tc.stopTracking);
router.get('/today', protect, tc.getTodaySessions);
router.get('/live', protect, authorize('admin', 'hr'), tc.getLiveEmployees);
router.get('/session/:id', protect, tc.getSessionRoute);
module.exports = router;
