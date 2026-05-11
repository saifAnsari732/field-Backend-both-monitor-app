const mongoose = require('mongoose');

// ─── Live Location ────────────────────────────────────────────────────────────
const liveLocationSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  coordinates: [{
    lat: Number,
    lng: Number,
    speed: Number,
    accuracy: Number,
    timestamp: { type: Date, default: Date.now },
  }],
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  totalDistance: { type: Number, default: 0 }, // in km
  isActive: { type: Boolean, default: true },
  date: { type: String }, // YYYY-MM-DD
}, { timestamps: true });

// ─── Meeting ──────────────────────────────────────────────────────────────────
const meetingSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientName: { type: String, required: true },
  companyName: String,
  mobileNumber: String,
  meetingAddress: String,
  meetingNotes: String,
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled', 'follow-up'], default: 'scheduled' },
  dealAmount: { type: Number, default: 0 },
  followUpDate: Date,
  images: [String],
  location: { lat: Number, lng: Number },
  date: { type: Date, default: Date.now },
}, { timestamps: true });

// ─── Expense ──────────────────────────────────────────────────────────────────
const expenseSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: ['fuel', 'food', 'hotel', 'travel', 'misc'], required: true },
  amount: { type: Number, required: true },
  description: String,
  date: { type: Date, default: Date.now },
  receipts: [String],
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: String,
}, { timestamps: true });

// ─── Attendance ───────────────────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  checkIn: Date,
  checkOut: Date,
  status: { type: String, enum: ['present', 'absent', 'half-day', 'leave'], default: 'present' },
  totalWorkHours: Number,
  trackingSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LiveLocation' }],
  totalDistanceTraveled: { type: Number, default: 0 },
}, { timestamps: true });

// ─── Activity Log ─────────────────────────────────────────────────────────────
const activityLogSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  description: String,
  metadata: mongoose.Schema.Types.Mixed,
  ip: String,
}, { timestamps: true });

// ─── Notification ─────────────────────────────────────────────────────────────
const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['expense', 'meeting', 'tracking', 'alert', 'system', 'attendance'] },
  title: String,
  message: String,
  isRead: { type: Boolean, default: false },
  data: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

module.exports = {
  LiveLocation: mongoose.model('LiveLocation', liveLocationSchema),
  Meeting: mongoose.model('Meeting', meetingSchema),
  Expense: mongoose.model('Expense', expenseSchema),
  Attendance: mongoose.model('Attendance', attendanceSchema),
  ActivityLog: mongoose.model('ActivityLog', activityLogSchema),
  Notification: mongoose.model('Notification', notificationSchema),
};
