const { LiveLocation, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');

// @desc Start tracking session
exports.startTracking = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    const address = await reverseGeocode(lat, lng);
    const session = await LiveLocation.create({
      employee: req.user._id,
      sessionId: uuidv4(),
      coordinates: [{ lat, lng, timestamp: new Date(), address }],
      isActive: true,
      date: today,
      startAddress: address,
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
    
    // Get end address from last coordinate
    if (session.coordinates.length > 0) {
      session.endAddress = session.coordinates[session.coordinates.length - 1].address;
    }
    
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

// @desc Geocode proxy (frontend calls this instead of Nominatim directly)
exports.geocode = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng required' });
    const address = await reverseGeocode(parseFloat(lat), parseFloat(lng));
    res.json({ success: true, address });
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

// @desc Get live locations (optimized for polling)
exports.getLiveLocations = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    
    // Get all active tracking sessions
    const activeSessions = await LiveLocation.find({
      isActive: true,
      date: today,
    }).populate('employee', 'name employeeId avatar department');

    // Format for frontend
    const locations = activeSessions.map(session => {
      const latestCoord = session.coordinates[session.coordinates.length - 1] || {};
      return {
        employeeId: session.employee._id,
        name: session.employee.name,
        employeeIdCode: session.employee.employeeId,
        avatar: session.employee.avatar,
        department: session.employee.department,
        lat: latestCoord.lat,
        lng: latestCoord.lng,
        speed: latestCoord.speed || 0,
        address: latestCoord.address,
        totalDistance: session.totalDistance || 0,
        sessionId: session.sessionId,
        startTime: session.startTime,
        updatedAt: latestCoord.timestamp || session.updatedAt,
      };
    });

    res.json({ success: true, locations, count: locations.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get employee report (with date range)
exports.getEmployeeReport = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate authorization: user can only see their own report, admins can see anyone's
    if (req.user.role === 'employee' && req.user._id.toString() !== employeeId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const employee = await User.findById(employeeId).select('name employeeId department');
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    // Build date filter
    const query = { employee: employeeId };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    // Get attendance records
    const attendanceRecords = await Attendance.find(query)
      .populate('trackingSessions')
      .sort({ date: -1 });

    // Get tracking sessions for the period
    const sessions = await LiveLocation.find(query).sort({ date: -1 });

    // Calculate statistics
    const stats = {
      totalDays: attendanceRecords.length,
      presentDays: attendanceRecords.filter(a => a.status === 'present').length,
      totalDistance: sessions.reduce((sum, s) => sum + (s.totalDistance || 0), 0),
      totalSessions: sessions.length,
      averageDistance: 0,
      totalHours: 0,
    };

    // Calculate average distance and hours
    if (sessions.length > 0) {
      stats.averageDistance = stats.totalDistance / sessions.length;
    }

    sessions.forEach(session => {
      if (session.endTime && session.startTime) {
        const hours = (session.endTime - session.startTime) / (1000 * 60 * 60);
        stats.totalHours += hours;
      }
    });

    // Format attendance data
    const attendanceData = attendanceRecords.map(record => ({
      date: record.date,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      status: record.status,
      totalDistance: record.totalDistanceTraveled || 0,
      sessionCount: record.trackingSessions?.length || 0,
    }));

    // Format session data
    const sessionData = sessions.map(session => ({
      date: session.date,
      sessionId: session.sessionId,
      startTime: session.startTime,
      endTime: session.endTime,
      distance: session.totalDistance || 0,
      coordinateCount: session.coordinates?.length || 0,
      startAddress: session.coordinates?.[0]?.address || 'N/A',
      endAddress: session.coordinates?.[session.coordinates.length - 1]?.address || 'N/A',
    }));

    res.json({
      success: true,
      employee: {
        id: employee._id,
        name: employee.name,
        employeeId: employee.employeeId,
        department: employee.department,
      },
      stats,
      attendance: attendanceData,
      sessions: sessionData,
      generatedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
