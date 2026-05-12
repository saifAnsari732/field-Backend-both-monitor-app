const express = require('express');
const router = express.Router();
const leaveController = require('../controllers/leave.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.use(protect);

router.post('/apply', authorize('employee'), leaveController.applyLeave);
router.get('/my', authorize('employee'), leaveController.getMyLeaves);

router.get('/all', authorize('admin', 'hr'), leaveController.getAllLeaves);
router.patch('/:id/status', authorize('admin', 'hr'), leaveController.updateLeaveStatus);

module.exports = router;
