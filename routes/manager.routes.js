const express = require('express');
const router = express.Router();
const managerController = require('../controllers/manager.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.use(protect);
router.use(authorize('manager'));

router.get('/dashboard-stats', managerController.getDashboardStats);
router.get('/team', managerController.getMyTeam);
router.get('/meetings', managerController.getTeamMeetings);
router.get('/expenses', managerController.getTeamExpenses);
router.get('/attendance', managerController.getTeamAttendance);
router.get('/tracking-history', managerController.getTeamTrackingHistory);

module.exports = router;
