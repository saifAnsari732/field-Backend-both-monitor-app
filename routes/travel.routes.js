const express = require('express');
const router = express.Router();
const { createTravelLog, getTravelLogs, deleteTravelLog } = require('../controllers/travel.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.route('/')
  .post(protect, createTravelLog)
  .get(protect, getTravelLogs);

router.route('/:id')
  .delete(protect, authorize('admin', 'hr'), deleteTravelLog);

module.exports = router;
