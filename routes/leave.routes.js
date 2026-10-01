const express = require('express');
const router = express.Router();
const leaveController = require('../controllers/leave.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.use(protect);

router.post('/apply', leaveController.applyLeave);
router.get('/my', leaveController.getMyLeaves);

router.get('/all', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), leaveController.getAllLeaves);
router.patch('/:id/status', authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), leaveController.updateLeaveStatus);

module.exports = router;
