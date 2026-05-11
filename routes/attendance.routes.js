const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const { Attendance } = require('../models/index');

router.get('/my', protect, async (req, res) => {
  try {
    const records = await Attendance.find({ employee: req.user._id }).sort({ date: -1 }).limit(30);
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/today', protect, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const record = await Attendance.findOne({ employee: req.user._id, date: today });
    res.json({ success: true, record });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
