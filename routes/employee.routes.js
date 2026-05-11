const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const User = require('../models/User.model');

router.get('/', protect, authorize('admin', 'hr'), async (req, res) => {
  try {
    const employees = await User.find({ role: 'employee' }).select('-password').sort({ createdAt: -1 });
    res.json({ success: true, employees });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const employee = await User.findById(req.params.id).select('-password').populate('manager', 'name email');
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/:id', protect, authorize('admin', 'hr'), async (req, res) => {
  try {
    const employee = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Employee deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
