const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { Notification } = require('../models/index');

router.get('/', protect, async (req, res) => {
  try {
    // Silently mark legacy auto-stop notifications as read in background
    Notification.updateMany(
      {
        recipient: req.user._id,
        isRead: false,
        $or: [
          { title: /Tracking stopped automatically/i },
          { message: /without accepted GPS movement/i }
        ]
      },
      { $set: { isRead: true } }
    ).catch(() => {});

    // Exclude legacy auto-stop notifications from payload
    const filter = {
      recipient: req.user._id,
      title: { $not: /Tracking stopped automatically/i },
      message: { $not: /without accepted GPS movement/i }
    };

    const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
    const unread = await Notification.countDocuments({ ...filter, isRead: false });
    res.json({ success: true, notifications, unread });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/read-all', protect, async (req, res) => {
  try {
    await Notification.updateMany({ recipient: req.user._id, isRead: false }, { isRead: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
