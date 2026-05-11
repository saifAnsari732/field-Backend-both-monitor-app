// admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
router.get('/dashboard', protect, authorize('admin', 'hr'), ac.getDashboardStats);
router.get('/employees', protect, authorize('admin', 'hr'), ac.getAllEmployees);
router.put('/employees/:id/approve', protect, authorize('admin', 'hr'), ac.approveEmployee);
router.put('/employees/:id/block', protect, authorize('admin', 'hr'), ac.toggleBlock);
router.get('/attendance', protect, authorize('admin', 'hr'), ac.getAttendanceReport);
router.get('/tracking-history', protect, authorize('admin', 'hr'), ac.getTrackingHistory);
module.exports = router;
