// tracking.routes.js
const express = require('express');
const { protect, authorize } = require('../middleware/auth.middleware');
const tc = require('../controllers/tracking.controller');
const ac = require('../controllers/admin.controller');

const trackingRouter = express.Router();
trackingRouter.post('/start', protect, tc.startTracking);
trackingRouter.post('/update', protect, tc.updateLocation);
trackingRouter.post('/stop', protect, tc.stopTracking);
trackingRouter.get('/today', protect, tc.getTodaySessions);
trackingRouter.get('/live', protect, authorize('admin', 'hr'), tc.getLiveEmployees);
trackingRouter.get('/session/:id', protect, authorize('admin', 'hr'), tc.getSessionRoute);
module.exports.trackingRouter = trackingRouter;

// meeting.routes.js
const meetingRouter = express.Router();
meetingRouter.post('/', protect, ac.createMeeting);
meetingRouter.get('/my', protect, ac.getMyMeetings);
meetingRouter.put('/:id', protect, ac.updateMeeting);
meetingRouter.get('/all', protect, authorize('admin', 'hr'), ac.getAllMeetings);
module.exports.meetingRouter = meetingRouter;

// expense.routes.js
const expenseRouter = express.Router();
expenseRouter.post('/', protect, ac.createExpense);
expenseRouter.get('/my', protect, ac.getMyExpenses);
expenseRouter.get('/all', protect, authorize('admin', 'hr'), ac.getAllExpenses);
expenseRouter.put('/:id/approve', protect, authorize('admin', 'hr'), ac.approveExpense);
module.exports.expenseRouter = expenseRouter;

// admin.routes.js
const adminRouter = express.Router();
adminRouter.get('/dashboard', protect, authorize('admin', 'hr'), ac.getDashboardStats);
adminRouter.get('/employees', protect, authorize('admin', 'hr'), ac.getAllEmployees);
adminRouter.put('/employees/:id/approve', protect, authorize('admin', 'hr'), ac.approveEmployee);
adminRouter.put('/employees/:id/block', protect, authorize('admin', 'hr'), ac.toggleBlock);
adminRouter.get('/attendance', protect, authorize('admin', 'hr'), ac.getAttendanceReport);
module.exports.adminRouter = adminRouter;
