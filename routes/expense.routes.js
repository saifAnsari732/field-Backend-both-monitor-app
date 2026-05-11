const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const ac = require('../controllers/admin.controller');
router.post('/', protect, ac.createExpense);
router.get('/my', protect, ac.getMyExpenses);
router.get('/all', protect, authorize('admin', 'hr'), ac.getAllExpenses);
router.put('/:id/approve', protect, authorize('admin', 'hr'), ac.approveExpense);
module.exports = router;
