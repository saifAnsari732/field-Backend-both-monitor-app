const express = require('express');
const r1 = express.Router();
const r2 = express.Router();
const r3 = express.Router();
const r4 = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const User = require('../models/User.model');
const { Attendance, ActivityLog, Notification } = require('../models/index');
const ImageKit = require('imagekit');

// ─── Employee Routes ─────────────────────────────────────────────────────────
r1.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id).populate('manager', 'name email avatar');
  res.json({ success: true, employee: user });
});
r1.get('/:id', protect, authorize('admin', 'hr'), async (req, res) => {
  const employee = await User.findById(req.params.id).populate('manager', 'name email');
  res.json({ success: true, employee });
});
r1.put('/:id', protect, authorize('admin', 'hr'), async (req, res) => {
  const employee = await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ success: true, employee });
});
r1.delete('/:id', protect, authorize('admin'), async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Employee deleted' });
});

// ─── Attendance Routes ────────────────────────────────────────────────────────
r2.get('/my', protect, async (req, res) => {
  const { month, year } = req.query;
  const filter = { employee: req.user._id };
  if (month && year) {
    filter.date = { $regex: `^${year}-${String(month).padStart(2, '0')}` };
  }
  const records = await Attendance.find(filter).sort({ date: -1 });
  res.json({ success: true, records });
});
r2.get('/today', protect, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const record = await Attendance.findOne({ employee: req.user._id, date: today });
  res.json({ success: true, record });
});

// ─── Notification Routes ─────────────────────────────────────────────────────
r3.get('/', protect, async (req, res) => {
  const notifications = await Notification.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ success: true, notifications });
});
r3.put('/:id/read', protect, async (req, res) => {
  await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
  res.json({ success: true });
});
r3.put('/read-all', protect, async (req, res) => {
  await Notification.updateMany({ recipient: req.user._id, isRead: false }, { isRead: true });
  res.json({ success: true });
});

// ─── Upload Routes (ImageKit) ─────────────────────────────────────────────────
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_key_placeholder',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_key_placeholder',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/placeholder',
});

r4.get('/auth', protect, (req, res) => {
  const result = imagekit.getAuthenticationParameters();
  res.json({ success: true, ...result });
});

r4.post('/image', protect, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { file, fileName, folder = '/crm-tracker' } = req.body;
    const response = await imagekit.upload({ file, fileName, folder });
    res.json({ success: true, url: response.url, fileId: response.fileId, thumbnailUrl: response.thumbnailUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = { employeeRouter: r1, attendanceRouter: r2, notificationRouter: r3, uploadRouter: r4 };
