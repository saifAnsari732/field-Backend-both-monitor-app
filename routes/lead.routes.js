const express = require('express');
const router = express.Router();
const { createLead, getLeads, updateLead, deleteLead } = require('../controllers/lead.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

router.route('/')
  .post(protect, authorize('admin', 'hr'), createLead)
  .get(protect, getLeads);

router.route('/:id')
  .put(protect, updateLead)
  .delete(protect, authorize('admin', 'hr'), deleteLead);

module.exports = router;
