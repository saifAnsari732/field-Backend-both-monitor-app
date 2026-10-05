// tracking.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const tc = require('../controllers/tracking.controller');

// Tracking session management
router.post('/start', protect, tc.startTracking);
router.post('/update', protect, tc.updateLocation);
router.post('/stop', protect, tc.stopTracking);
router.post('/heartbeat', protect, tc.heartbeat); // Keepalive — resets inactivity clock, no distance added

// Get data
router.get('/today', protect, tc.getTodaySessions);
router.get('/live', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), tc.getLiveEmployees);
router.get('/live-locations', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), tc.getLiveLocations);
router.get('/session/:id', protect, tc.getSessionRoute);
router.get('/geocode', protect, tc.geocode);
router.get('/diagnostic', protect, tc.getSessionDiagnostic);

// Reconcile distance from DistanceLedger
router.post('/reconcile', protect, tc.reconcileSession);
router.get('/session/:id/reconcile', protect, tc.reconcileSession);

// Reports
router.get('/report/employee/:employeeId', protect, tc.getEmployeeReport);

// Delete history
router.delete('/history/employee/:employeeId', protect, authorize('admin', 'org_admin', 'super_admin'), tc.deleteEmployeeHistory);

module.exports = router;
