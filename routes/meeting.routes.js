const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
router.post('/', protect, ac.createMeeting);
router.get('/my', protect, ac.getMyMeetings);
router.put('/:id', protect, ac.updateMeeting);
router.get('/all', protect, authorize('admin', 'hr'), ac.getAllMeetings);
module.exports = router;
