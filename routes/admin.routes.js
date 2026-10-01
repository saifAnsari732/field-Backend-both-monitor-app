// admin.routes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
const rc = require('../controllers/report.controller');

router.get('/dashboard', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getDashboardStats);
router.get('/employees', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAllEmployees);
router.get('/managers', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getManagers);
router.put('/employees/:id/approve', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.approveEmployee);
router.put('/employees/:id/block', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.toggleBlock);
router.get('/attendance', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getAttendanceReport);
router.get('/tracking-history', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getTrackingHistory);
router.put('/employees/:id', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.updateEmployee);
router.get('/reports/consolidated', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), rc.getConsolidatedReport);
router.get('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.getOrganizationSettings);
router.put('/organization', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), ac.updateOrganizationSettings);

module.exports = router;
