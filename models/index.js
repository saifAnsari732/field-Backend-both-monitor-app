const mongoose = require('mongoose');

// Ensure Organization & User schemas are registered with Mongoose
const Organization = require('./Organization.model');
const User = require('./User.model');

// ─── Live Location ────────────────────────────────────────────────────────────
const liveLocationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  coordinates: [{
    lat:         Number,
    lng:         Number,
    speed:       Number,
    accuracy:    Number,
    heading:     Number,
    battery:     Number,
    address:     String,
    eventId:     String,        // Dedup key — prevents replay from inflating distance
    isHeartbeat: Boolean,       // True for keepalive pings; no distance is added
    timestamp:   { type: Date, default: Date.now },
  }],
  startTime:           { type: Date, default: Date.now },
  endTime:             Date,
  startAddress:        String,
  endAddress:          String,
  selfieUrl:           { type: String, default: null },
  totalDistance:       { type: Number, default: 0 },     // km, written with $max (never decreases)
  manualDistanceAdded: { type: Number, default: 0 },     // admin KM credit
  manualAdjustmentReason: { type: String, default: null }, // audit note for adjustment
  // ─── AGTRIE-X v7 Session Audit Ledger ───────────
  rawGpsDistance:      { type: Number, default: 0 },     // Raw unprocessed distance sum
  acceptedDistance:    { type: Number, default: 0 },     // High-confidence verified distance
  recoveredDistance:   { type: Number, default: 0 },     // Recovered through kinematic smoothing
  unverifiedDistance:  { type: Number, default: 0 },     // Distance from poor GPS that couldn't be verified
  rejectedDistance:    { type: Number, default: 0 },     // Distance from rejected jumps/teleports
  officialDistance:    { type: Number, default: 0 },     // Final authoritative KM = accepted + recovered
  distanceUncertainty: { type: Number, default: 0 },     // +/- sigma KM confidence bound
  gpsPointCount:       { type: Number, default: 0 },     // Total raw GPS points received
  acceptedPointCount:  { type: Number, default: 0 },     // Points that passed all validation
  recoveredPointCount: { type: Number, default: 0 },     // Points recovered via RTS smoothing
  rejectedPointCount:  { type: Number, default: 0 },     // Points rejected (teleport, jitter, etc.)
  gpsLostCount:        { type: Number, default: 0 },     // Number of GPS loss events detected
  gapCount:            { type: Number, default: 0 },     // Number of time gaps > 60 seconds
  averageAccuracy:     { type: Number, default: 0 },     // Average GPS accuracy in meters
  worstAccuracy:       { type: Number, default: 0 },     // Worst single GPS accuracy
  maxSpeed:            { type: Number, default: 0 },     // Maximum recorded speed in km/h
  algorithmVersion:    { type: String, default: 'AGTRIE-X-v7-DURABLE' },
  motionState:         { type: String, enum: ['STATIONARY', 'WALKING', 'RUNNING', 'BIKE', 'VEHICLE', 'GPS_LOST', 'UNKNOWN'], default: 'STATIONARY' },
  rejectionReasons:    [{ timestamp: Date, reason: String, lat: Number, lng: Number, accuracy: Number, speed: Number }],
  isActive:            { type: Boolean, default: true },
  autoClosed:          { type: Boolean, default: false }, // true = closed by inactivity cron (resumable)
  date:                { type: String },                  // YYYY-MM-DD
  lastActivity:        { type: Date, default: Date.now }, // Updated on GPS update + heartbeat
}, { timestamps: true });

liveLocationSchema.index({ organizationId: 1, employee: 1, date: -1 });
liveLocationSchema.index({ organizationId: 1, isActive: 1, lastActivity: 1 }); // Inactivity cron
liveLocationSchema.index({ sessionId: 1 }, { unique: true });

// ─── Tracking Point (Raw GPS Event Storage - Golden Rule: Save First) ───────────
const trackingPointSchema = new mongoose.Schema({
  organizationId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId:        { type: String, required: true },
  eventId:          { type: String, required: true },
  timestamp:        { type: Date, required: true },
  receivedAt:       { type: Date, default: Date.now },
  lat:              { type: Number, required: true },
  lng:              { type: Number, required: true },
  accuracy:         { type: Number, default: 0 },
  speed:            { type: Number, default: 0 },
  heading:          { type: Number, default: 0 },
  altitude:         { type: Number, default: 0 },
  provider:         { type: String, default: 'gps' },
  processingStatus: { 
    type: String, 
    enum: ['PENDING', 'ACCEPTED', 'RECOVERED', 'UNVERIFIED', 'REJECTED', 'DUPLICATE'], 
    default: 'PENDING' 
  },
  algorithmVersion: { type: String, default: 'AGTRIE-X-v7-DURABLE' }
}, { timestamps: true });

trackingPointSchema.index({ sessionId: 1, eventId: 1 }, { unique: true });
trackingPointSchema.index({ sessionId: 1, timestamp: 1 });
trackingPointSchema.index({ organizationId: 1, employee: 1, timestamp: -1 });

// ─── Distance Ledger (Immutable Segment Store - Source of Truth) ────────────
const distanceLedgerSchema = new mongoose.Schema({
  organizationId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId:        { type: String, required: true },
  fromEventId:      { type: String },
  toEventId:        { type: String, required: true },
  fromTimestamp:    { type: Date },
  toTimestamp:      { type: Date, required: true },
  fromLat:          { type: Number },
  fromLng:          { type: Number },
  toLat:            { type: Number, required: true },
  toLng:            { type: Number, required: true },
  distanceMeters:   { type: Number, required: true },
  distanceKm:       { type: Number, required: true },
  classification:   { 
    type: String, 
    enum: ['ACCEPTED', 'RECOVERED', 'UNVERIFIED', 'REJECTED'], 
    default: 'ACCEPTED' 
  },
  reason:           { type: String, default: 'NORMAL_TRAJECTORY' },
  algorithmVersion: { type: String, default: 'AGTRIE-X-v7-DURABLE' }
}, { timestamps: true });

distanceLedgerSchema.index({ sessionId: 1, fromTimestamp: 1 });
distanceLedgerSchema.index({ sessionId: 1, toTimestamp: 1 });
distanceLedgerSchema.index({ organizationId: 1, employee: 1, toTimestamp: -1 });

// ─── Meeting ──────────────────────────────────────────────────────────────────
const meetingSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
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

meetingSchema.index({ organizationId: 1, employee: 1, date: -1 });
meetingSchema.index({ organizationId: 1, status: 1 });

// ─── Expense ──────────────────────────────────────────────────────────────────
const expenseSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: ['fuel', 'food', 'hotel', 'travel', 'misc'], required: true },
  amount: { type: Number, required: true },
  description: String,
  date: { type: Date, default: Date.now },
  receipts: [String],
  travelDetails: {
    mode: { type: String, enum: ['bike', 'train', 'bus', 'taxi'] },
    source: String,
    destination: String,
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: String,
}, { timestamps: true });

expenseSchema.index({ organizationId: 1, employee: 1, date: -1 });
expenseSchema.index({ organizationId: 1, status: 1 });

// ─── Attendance ───────────────────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  checkIn: Date,
  checkOut: Date,
  status: { type: String, enum: ['present', 'absent', 'half-day', 'leave'], default: 'present' },
  totalWorkHours: Number,
  trackingSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LiveLocation' }],
  totalDistanceTraveled: { type: Number, default: 0 },
}, { timestamps: true });

attendanceSchema.index({ organizationId: 1, employee: 1, date: -1 }, { unique: true });
attendanceSchema.index({ organizationId: 1, date: 1, status: 1 });

// ─── Activity Log ─────────────────────────────────────────────────────────────
const activityLogSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  description: String,
  metadata: mongoose.Schema.Types.Mixed,
  ip: String,
}, { timestamps: true });

activityLogSchema.index({ organizationId: 1, employee: 1, createdAt: -1 });

// ─── Notification ─────────────────────────────────────────────────────────────
const notificationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['expense', 'meeting', 'tracking', 'alert', 'system', 'attendance', 'leave', 'task', 'lead'] },
  title: String,
  message: String,
  isRead: { type: Boolean, default: false },
  data: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

notificationSchema.index({ organizationId: 1, recipient: 1, createdAt: -1 });
notificationSchema.index({ isRead: 1 });

// ─── Leave ────────────────────────────────────────────────────────────────────
const leaveSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
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

leaveSchema.index({ organizationId: 1, employee: 1, status: 1 });

// ─── Task ─────────────────────────────────────────────────────────────────────
const taskSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  title: { type: String, required: true },
  description: String,
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: Date,
  status: { type: String, enum: ['pending', 'in-progress', 'completed', 'overdue'], default: 'pending' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  completedAt: Date,
  duration: String,
  location: { lat: Number, lng: Number, address: String },
}, { timestamps: true });

taskSchema.index({ organizationId: 1, employee: 1, status: 1 });
taskSchema.index({ organizationId: 1, assignedBy: 1 });

// ─── Lead ─────────────────────────────────────────────────────────────────────
const leadSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  name: { type: String, required: true },
  contactNo: { type: String, required: true },
  address: String,
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'completed', 'follow-up'], default: 'pending' },
  feedback: String,
  lastContacted: Date,
}, { timestamps: true });

leadSchema.index({ organizationId: 1, assignedTo: 1, status: 1 });

// ─── Travel Log ───────────────────────────────────────────────────────────────
const travelLogSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mode: { type: String, enum: ['bus', 'train', 'other'], required: true },
  source: { type: String, required: true },
  destination: { type: String, required: true },
  ticketPhoto: String,
  date: { type: Date, default: Date.now },
  amount: Number,
}, { timestamps: true });

travelLogSchema.index({ organizationId: 1, employee: 1, date: -1 });

module.exports = {
  Organization,
  User,
  LiveLocation: mongoose.model('LiveLocation', liveLocationSchema),
  TrackingPoint: mongoose.model('TrackingPoint', trackingPointSchema),
  DistanceLedger: mongoose.model('DistanceLedger', distanceLedgerSchema),
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

