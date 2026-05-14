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
    address: String,
    timestamp: { type: Date, default: Date.now },
  }],
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  startAddress: String,
  endAddress: String,
  totalDistance: { type: Number, default: 0 }, // in km
  isActive: { type: Boolean, default: true },
  date: { type: String }, // YYYY-MM-DD
}, { timestamps: true });

liveLocationSchema.index({ employee: 1, date: -1 });
liveLocationSchema.index({ sessionId: 1 });
liveLocationSchema.index({ isActive: 1 });

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

meetingSchema.index({ employee: 1, date: -1 });
meetingSchema.index({ status: 1 });

// ─── Expense ──────────────────────────────────────────────────────────────────
const expenseSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: ['fuel', 'food', 'hotel', 'travel', 'misc'], required: true },
  amount: { type: Number, required: true },
  description: String,
  date: { type: Date, default: Date.now },
  receipts: [String],
  travelDetails: {
    mode: { type: String, enum: ['bike', 'train', 'bus', 'taxi'] },
    source: String,
    destination: String
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: String,
}, { timestamps: true });

expenseSchema.index({ employee: 1, date: -1 });
expenseSchema.index({ status: 1 });

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

attendanceSchema.index({ employee: 1, date: -1 }, { unique: true });

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
  type: { type: String, enum: ['expense', 'meeting', 'tracking', 'alert', 'system', 'attendance', 'leave', 'task'] },
  title: String,
  message: String,
  isRead: { type: Boolean, default: false },
  data: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ isRead: 1 });

// ─── Leave ────────────────────────────────────────────────────────────────────
const leaveSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['sick', 'casual', 'annual', 'other'], default: 'casual' },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: String,
  duration: Number, // in days
}, { timestamps: true });

leaveSchema.index({ employee: 1, status: 1 });

// ─── Task ─────────────────────────────────────────────────────────────────────
const taskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: Date,
  status: { type: String, enum: ['pending', 'in-progress', 'completed', 'overdue'], default: 'pending' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  completedAt: Date,
  duration: String, // e.g. "2 hrs"
  location: { lat: Number, lng: Number, address: String },
}, { timestamps: true });

taskSchema.index({ employee: 1, status: 1 });
taskSchema.index({ assignedBy: 1 });

// ─── Lead ─────────────────────────────────────────────────────────────────────
const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contactNo: { type: String, required: true },
  address: String,
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'completed', 'follow-up'], default: 'pending' },
  feedback: String,
  lastContacted: Date,
}, { timestamps: true });

leadSchema.index({ assignedTo: 1, status: 1 });

// ─── Travel Log ───────────────────────────────────────────────────────────────
const travelLogSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mode: { type: String, enum: ['bus', 'train', 'other'], required: true },
  source: { type: String, required: true },
  destination: { type: String, required: true },
  ticketPhoto: String,
  date: { type: Date, default: Date.now },
  amount: Number,
}, { timestamps: true });

travelLogSchema.index({ employee: 1, date: -1 });

module.exports = {
  LiveLocation: mongoose.model('LiveLocation', liveLocationSchema),
  Meeting: mongoose.model('Meeting', meetingSchema),
  Expense: mongoose.model('Expense', expenseSchema),
  Attendance: mongoose.model('Attendance', attendanceSchema),
  ActivityLog: mongoose.model('ActivityLog', activityLogSchema),
  Notification: mongoose.model('Notification', notificationSchema),
  Leave: mongoose.model('Leave', leaveSchema),
  Task: mongoose.model('Task', taskSchema),
  Lead: mongoose.model('Lead', leadSchema),
  TravelLog: mongoose.model('TravelLog', travelLogSchema),
};
