// admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
const rc = require('../controllers/report.controller');
router.get('/dashboard', protect, authorize('admin', 'hr'), ac.getDashboardStats);
router.get('/employees', protect, authorize('admin', 'hr'), ac.getAllEmployees);
router.get('/managers', protect, authorize('admin', 'hr'), ac.getManagers);
router.put('/employees/:id/approve', protect, authorize('admin', 'hr'), ac.approveEmployee);
router.put('/employees/:id/block', protect, authorize('admin', 'hr'), ac.toggleBlock);
router.get('/attendance', protect, authorize('admin', 'hr'), ac.getAttendanceReport);
router.get('/tracking-history', protect, authorize('admin', 'hr'), ac.getTrackingHistory);
router.put('/employees/:id', protect, authorize('admin', 'hr'), ac.updateEmployee);
router.get('/reports/consolidated', protect, authorize('admin', 'hr'), rc.getConsolidatedReport);
router.get('/managers', protect, authorize('admin', 'hr'), ac.getManagers);
module.exports = router;
