const { LiveLocation, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');

// @desc Start tracking session
exports.startTracking = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    const session = await LiveLocation.create({
      employee: req.user._id,
      sessionId: uuidv4(),
      coordinates: [{ lat, lng, timestamp: new Date() }],
      isActive: true,
      date: today,
    });

    await User.findByIdAndUpdate(req.user._id, { isTracking: true });

    // Attendance check-in
    let attendance = await Attendance.findOne({ employee: req.user._id, date: today });
    if (!attendance) {
      attendance = await Attendance.create({
        employee: req.user._id, date: today,
        checkIn: new Date(), status: 'present',
        trackingSessions: [session._id],
      });
    } else {
      attendance.trackingSessions.push(session._id);
      await attendance.save();
    }

    await ActivityLog.create({
      employee: req.user._id, action: 'TRACKING_START',
      description: 'Location tracking started', metadata: { lat, lng, sessionId: session.sessionId }
    });

    const io = req.app.get('io');
    io.to('admins').emit('employee_tracking_started', {
      employeeId: req.user._id, name: req.user.name, lat, lng, sessionId: session.sessionId
    });

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const { reverseGeocode } = require('../services/geocode.service');

// @desc Update location (bulk coordinates)
exports.updateLocation = async (req, res) => {
  try {
    const { sessionId, coordinates } = req.body; 
    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    // Geocode the latest coordinate
    const lastCoord = coordinates[coordinates.length - 1];
    const address = await reverseGeocode(lastCoord.lat, lastCoord.lng);
    
    // Add address to coordinates
    const updatedCoords = coordinates.map(c => ({ ...c, address }));
    session.coordinates.push(...updatedCoords);

    // Calculate distance
    const coords = session.coordinates;
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
      totalDist += haversineDistance(coords[i - 1], coords[i]);
    }
    session.totalDistance = totalDist;
    await session.save();

    // Emit to admin in real-time
    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: lastCoord.lat,
      lng: lastCoord.lng,
      speed: lastCoord.speed,
      address,
      totalDistance: totalDist,
      sessionId,
    });

    res.json({ success: true, totalDistance: totalDist });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Stop tracking session
exports.stopTracking = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    session.isActive = false;
    session.endTime = new Date();
    await session.save();

    await User.findByIdAndUpdate(req.user._id, { isTracking: false });

    const today = new Date().toISOString().slice(0, 10);
    const allSessions = await LiveLocation.find({ employee: req.user._id, date: today });
    const totalDist = allSessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: today },
      { checkOut: new Date(), totalDistanceTraveled: totalDist }
    );

    await ActivityLog.create({
      employee: req.user._id, action: 'TRACKING_STOP',
      description: `Tracking stopped. Distance: ${totalDist.toFixed(2)} km`,
      metadata: { sessionId, totalDistance: totalDist }
    });

    const io = req.app.get('io');
    io.to('admins').emit('employee_tracking_stopped', {
      employeeId: req.user._id, name: req.user.name, sessionId, totalDistance: totalDist
    });

    res.json({ success: true, totalDistance: totalDist, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get today's tracking sessions
exports.getTodaySessions = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sessions = await LiveLocation.find({ employee: req.user._id, date: today })
      .sort({ createdAt: -1 });
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get session route (admin)
exports.getSessionRoute = async (req, res) => {
  try {
    const session = await LiveLocation.findById(req.params.id).populate('employee', 'name employeeId');
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get all live employees (admin)
exports.getLiveEmployees = async (req, res) => {
  try {
    const employees = await User.find({ isTracking: true, isOnline: true })
      .select('name employeeId department avatar isTracking isOnline lastSeen');
    const locations = await LiveLocation.find({
      isActive: true, date: new Date().toISOString().slice(0, 10)
    }).populate('employee', 'name employeeId avatar department');
    res.json({ success: true, employees, locations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Haversine formula
function haversineDistance(p1, p2) {
  const R = 6371;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * (Math.PI / 180); }
