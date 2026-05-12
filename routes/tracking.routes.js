// tracking.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const tc = require('../controllers/tracking.controller');

// Tracking session management
router.post('/start', protect, tc.startTracking);
router.post('/update', protect, tc.updateLocation);
router.post('/stop', protect, tc.stopTracking);

// Get data
router.get('/today', protect, tc.getTodaySessions);
router.get('/live', protect, authorize('admin', 'hr'), tc.getLiveEmployees);
router.get('/live-locations', protect, authorize('admin', 'hr'), tc.getLiveLocations);
router.get('/session/:id', protect, tc.getSessionRoute);
router.get('/geocode', protect, tc.geocode);

// Reports
router.get('/report/employee/:employeeId', protect, tc.getEmployeeReport);

// Delete history
router.delete('/history/employee/:employeeId', protect, authorize('admin'), tc.deleteEmployeeHistory);

module.exports = router;

