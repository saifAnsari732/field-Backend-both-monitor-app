const { LiveLocation, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');
const { liveCache, saveSessionState, getSessionState, incrementSessionDistance, clearSessionState } = require('../services/cache.service');

const sessionLocks = new Map();
const acquireSessionLock = async (sessionId) => {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  sessionLocks.set(sessionId, queued);
  await previous;
  return () => {
    release();
    if (sessionLocks.get(sessionId) === queued) sessionLocks.delete(sessionId);
  };
};

// @desc Start tracking session
exports.startTracking = async (req, res) => {
  try {
    const { lat, lng, selfieUrl } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    // Start geocoding in background to avoid blocking the response
    const addressPromise = reverseGeocode(lat, lng);
    
    // Create session with temporary address if needed, or wait briefly
    // To keep it simple and responsive, we'll wait max 500ms for geocode
    const address = await Promise.race([
      addressPromise,
      new Promise(resolve => setTimeout(() => resolve(`Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`), 800))
    ]);

    const session = await LiveLocation.create({
      employee: req.user._id,
      sessionId: uuidv4(),
      coordinates: [{ lat, lng, timestamp: new Date(), address }],
      isActive: true,
      date: today,
      startAddress: address,
      startTime: new Date(),
      selfieUrl: selfieUrl,
    });

    // Seed the authoritative distance state before the first GPS update arrives.
    // This keeps live admin responses in sync even while Mongo persistence runs asynchronously.
    await saveSessionState(session.sessionId, {
      totalDistance: 0,
      lastLat: Number(lat),
      lastLng: Number(lng),
      lastTs: new Date().toISOString(),
    });

    // If geocode finishes later, update the session
    addressPromise.then(async (realAddr) => {
      if (realAddr !== address) {
        await LiveLocation.findByIdAndUpdate(session._id, { 
          startAddress: realAddr,
          'coordinates.0.address': realAddr 
        });
      }
    }).catch(() => {});

    await User.findByIdAndUpdate(req.user._id, { isTracking: true });

    // Attendance check-in
    let attendance = await Attendance.findOne({ employee: req.user._id, date: today });
    if (!attendance) {
      attendance = await Attendance.create({
        employee: req.user._id, date: today,
        checkIn: new Date(), status: 'present',
        trackingSessions: [session._id],
        checkInImage: selfieUrl,
      });
    } else {
      attendance.trackingSessions.push(session._id);
      if (selfieUrl && !attendance.checkInImage) {
        attendance.checkInImage = selfieUrl;
      }
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
  let releaseSessionLock;
  try {
    const { sessionId, coordinates } = req.body;
    if (!sessionId || !Array.isArray(coordinates) || coordinates.length === 0) {
      return res.status(400).json({ success: false, message: 'sessionId and coordinates are required' });
    }
    releaseSessionLock = await acquireSessionLock(sessionId);

    // ── Step 1: Get cached session state from Redis (O(1), no DB hit) ──────────
    let sessionState = await getSessionState(sessionId);

    // If no Redis state (e.g. server restarted), recover from DB
    if (!sessionState) {
      const dbSession = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true });
      if (!dbSession) return res.status(404).json({ success: false, message: 'Session not found' });
      const lastCoordDb = dbSession.coordinates[dbSession.coordinates.length - 1] || {};
      sessionState = {
        totalDistance: dbSession.totalDistance || 0,
        lastLat: lastCoordDb.lat || 0,
        lastLng: lastCoordDb.lng || 0,
        lastTs: lastCoordDb.timestamp || new Date().toISOString(),
      };
      // Re-seed Redis so next tick is fast again
      await saveSessionState(sessionId, sessionState);
    }

    // ── Step 2: Filter + calculate incremental distance ─────────────────────────
    const MIN_MOVE_KM   = 0.008; // 8 meters (matches frontend, captures road curves)
    const MAX_SPEED_KMH = 220;   // Teleport guard (airplane / GPS flip)
    const MAX_ACCURACY  = 500;   // 500m accuracy gate (allows pocket mode / weak signals)

    let incrementalDist = 0;
    let newLastLat = sessionState.lastLat;
    let newLastLng = sessionState.lastLng;
    let newLastTs  = sessionState.lastTs;
    const validCoords = [];

    const orderedCoordinates = [...coordinates].sort((first, second) => {
      return new Date(first?.timestamp).getTime() - new Date(second?.timestamp).getTime();
    });

    for (const coord of orderedCoordinates) {
      const lat = Number(coord?.lat);
      const lng = Number(coord?.lng);
      const timestamp = new Date(coord?.timestamp);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(timestamp.getTime())) continue;

      const normalizedCoord = { ...coord, lat, lng, timestamp: timestamp.toISOString() };

      // Deduplicate eventId
      if (coord.eventId) {
        const duplicate = await LiveLocation.exists({
          sessionId,
          employee: req.user._id,
          'coordinates.eventId': coord.eventId,
        });
        if (duplicate) continue;
      }

      // Ignore heartbeats or older timestamps
      if (coord.isHeartbeat) continue;
      if (newLastTs && timestamp.getTime() <= new Date(newLastTs).getTime()) continue;

      // Gate 1: Accuracy check (accept up to 500m accuracy for pocket mode)
      if (coord.accuracy && Number(coord.accuracy) > MAX_ACCURACY) continue;

      // Gate 2: Distance check (minimum 8 meters movement to ignore stationary jitter)
      const dist = haversineDistance({ lat: newLastLat, lng: newLastLng }, normalizedCoord); // km
      if (dist < MIN_MOVE_KM) continue;

      // Gate 3: Teleport protection (speed check calculated from time difference)
      const timeDiffSec = newLastTs ? (timestamp.getTime() - new Date(newLastTs).getTime()) / 1000 : 0;
      if (timeDiffSec > 0) {
        const calculatedSpeedKmh = (dist / timeDiffSec) * 3600;
        if (calculatedSpeedKmh > MAX_SPEED_KMH) continue; // Impossible speed jump
      }

      incrementalDist += dist;
      newLastLat = lat;
      newLastLng = lng;
      newLastTs  = timestamp.toISOString();
      validCoords.push(normalizedCoord);
    }

    // ── Step 3: Update Redis total atomically ─────────────────────────────────
    const newTotal = parseFloat((sessionState.totalDistance + incrementalDist).toFixed(3));
    await saveSessionState(sessionId, {
      totalDistance: newTotal,
      lastLat: newLastLat,
      lastLng: newLastLng,
      lastTs: newLastTs,
    });

    // ── Step 4: Persist the authoritative total before responding ────────────
    // Do not fire-and-forget this write: stop/restart immediately after a GPS
    // tick must still see the accepted distance in MongoDB.
    if (validCoords.length > 0) {
      const lastCoord = validCoords[validCoords.length - 1];
      const tagged = validCoords.map((coord) => ({ ...coord, address: coord.address || '' }));
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        {
          $push: { coordinates: { $each: tagged } },
          $max: { totalDistance: newTotal },
          $set: { lastActivity: new Date() },    // ← Reset inactivity clock on every valid GPS fix
        },
        { runValidators: true }
      );
      reverseGeocode(lastCoord.lat, lastCoord.lng).then((address) => {
        if (!address) return;
        return LiveLocation.updateOne(
          { sessionId, employee: req.user._id, isActive: true },
          { $set: { 'coordinates.$[point].address': address } },
          { arrayFilters: [{ 'point.eventId': lastCoord.eventId }] }
        );
      }).catch(() => {});
    } else {
      // Keep the durable total monotonic even when this batch has no point.
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        { $max: { totalDistance: newTotal } },
        { runValidators: true }
      ).catch(() => {});
    }

    // ── Step 5: Emit real-time to admin ───────────────────────────────────────
    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: newLastLat,
      lng: newLastLng,
      totalDistance: newTotal,
      sessionId,
    });

    res.json({ success: true, totalDistance: newTotal });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    releaseSessionLock?.();
  }
};

// @desc Stop tracking session
exports.stopTracking = async (req, res) => {
  try {
    const { sessionId } = req.body;

    // Get final authoritative distance from Redis before clearing
    const cachedState = await getSessionState(sessionId);
    const redisTotalDist = cachedState ? cachedState.totalDistance : null;

    const session = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    session.isActive = false;
    session.endTime = new Date();

    // Never allow a stale cache read to lower the durable MongoDB total.
    session.totalDistance = Math.max(
      Number(session.totalDistance) || 0,
      Number(redisTotalDist) || 0
    );

    // Get end address from last coordinate
    if (session.coordinates.length > 0) {
      session.endAddress = session.coordinates[session.coordinates.length - 1].address;
    }

    await session.save();

    // Clear Redis session state — shift is over
    await clearSessionState(sessionId);

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

// Close sessions whose last accepted GPS fix OR heartbeat is older than the inactivity window.
// Uses lastActivity field (updated on both GPS update and heartbeat) as the authoritative clock.
// Stationary employees sending heartbeats every 8 min will never be falsely auto-stopped.
exports.autoStopInactiveSessions = async (io, inactivityMs = 3 * 60 * 60 * 1000) => {
  const cutoff = new Date(Date.now() - inactivityMs);

  // Fetch only sessions where BOTH lastActivity AND last-coord are stale.
  // Compound index {isActive, lastActivity} makes this O(log n) instead of full scan.
  const staleSessions = await LiveLocation.find({
    isActive: true,
    $or: [
      { lastActivity: { $lt: cutoff } },
      { lastActivity: null, updatedAt: { $lt: cutoff } },
    ],
  }).select('employee sessionId coordinates totalDistance startTime date lastActivity');

  for (const candidate of staleSessions) {
    // Double-check with last GPS coordinate timestamp in case lastActivity wasn't set
    // (sessions created before this migration don't have lastActivity)
    const lastCoordTime = candidate.coordinates?.length
      ? new Date(candidate.coordinates[candidate.coordinates.length - 1].timestamp || 0)
      : null;
    const effectiveLastActive = candidate.lastActivity
      ? new Date(Math.max(
          new Date(candidate.lastActivity).getTime(),
          lastCoordTime ? lastCoordTime.getTime() : 0
        ))
      : (lastCoordTime || candidate.startTime);

    if (effectiveLastActive && Date.now() - effectiveLastActive.getTime() < inactivityMs) continue;

    // Claim atomically so overlapping cron ticks cannot close it twice.
    const session = await LiveLocation.findOneAndUpdate(
      { _id: candidate._id, isActive: true },
      { $set: { isActive: false, endTime: new Date(), totalDistance: Number(candidate.totalDistance) || 0 } },
      { new: true }
    );
    if (!session) continue;

    const totalDistance = Number(session.totalDistance) || 0;
    await clearSessionState(session.sessionId);
    await User.findByIdAndUpdate(session.employee, { isTracking: false });
    await Attendance.findOneAndUpdate(
      { employee: session.employee, date: session.date },
      { $set: { checkOut: new Date(), totalDistanceTraveled: totalDistance } }
    );
    await ActivityLog.create({
      employee: session.employee,
      action: 'TRACKING_AUTO_STOPPED',
      description: `Tracking auto-stopped after ${Math.round(inactivityMs / 3600000)} hour(s) of no movement. Distance: ${totalDistance.toFixed(2)} km`,
      metadata: { sessionId: session.sessionId, totalDistance, effectiveLastActive },
    });

    await Notification.create({
      recipient: session.employee,
      type: 'tracking',
      title: 'Tracking stopped automatically',
      message: `Tracking was stopped after ${Math.round(inactivityMs / 3600000)} hour without GPS movement. Start a new shift when you leave.`,
      data: { sessionId: session.sessionId, totalDistance },
    });

    io.to(String(session.employee)).emit('tracking_auto_stopped', {
      sessionId: session.sessionId,
      totalDistance,
      reason: 'no_movement_timeout',
    });
    io.to('admins').emit('employee_tracking_stopped', {
      employeeId: session.employee,
      sessionId: session.sessionId,
      totalDistance,
      reason: 'no_movement_timeout',
    });
    console.log(`⏹️ [TRACKING] Auto-stopped ${session.sessionId}; inactive since ${effectiveLastActive?.toISOString()}.`);
  }
};

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
// Mobile app calls this every ~8 minutes while the employee is stationary.
// Resets lastActivity so the 3-hour auto-stop cron doesn't fire on standing workers.
// Does NOT add distance (idempotent, safe to call multiple times).
exports.heartbeat = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId required' });

    const updated = await LiveLocation.findOneAndUpdate(
      { sessionId, employee: req.user._id, isActive: true },
      { $set: { lastActivity: new Date() } },
      { new: true, select: 'totalDistance isActive' }
    );

    if (!updated) {
      // Session was closed (auto-stop or manual) — tell the app
      return res.json({ success: false, sessionClosed: true, message: 'Session is no longer active.' });
    }

    // Keep user marked as online
    await User.findByIdAndUpdate(req.user._id, { isOnline: true, lastSeen: new Date() });

    // Return cached distance so mobile can sync its local display
    const sessionState = await getSessionState(sessionId);
    const totalDistance = sessionState?.totalDistance ?? updated.totalDistance ?? 0;

    res.json({ success: true, totalDistance });
  } catch (err) {
    console.error('[tracking] heartbeat error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get today's tracking sessions (optimized: no coordinates)
exports.getTodaySessions = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sessions = await LiveLocation.find(
      { employee: req.user._id, date: today },
      { coordinates: 0 } // Exclude coordinates for list view performance
    ).sort({ createdAt: -1 });
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get session route (admin)
exports.getSessionRoute = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Session id is required' });

    let session = null;
    // UUID session IDs must never be sent through findById; only a strict
    // 24-character Mongo ObjectId may use the _id lookup path.
    if (/^[0-9a-fA-F]{24}$/.test(id)) {
      session = await LiveLocation.findById(id).populate('employee', 'name employeeId avatar');
      // If not found by document _id, check if id is an Employee _id
      if (!session) {
        const today = new Date().toISOString().slice(0, 10);
        const daySessions = await LiveLocation.find({ employee: id, date: today })
          .sort({ startTime: 1 })
          .populate('employee', 'name employeeId avatar department');

        if (daySessions && daySessions.length > 0) {
          let cumulativeDistance = 0;
          let combinedCoordinates = [];

          daySessions.forEach((s) => {
            cumulativeDistance += Number(s.totalDistance) || 0;
            if (Array.isArray(s.coordinates)) {
              combinedCoordinates.push(...s.coordinates);
            }
          });

          const firstSess = daySessions[0];
          session = {
            _id: id,
            employee: firstSess.employee,
            totalDistance: Math.round(cumulativeDistance * 100) / 100,
            coordinates: combinedCoordinates,
            startTime: firstSess.startTime,
            endTime: daySessions[daySessions.length - 1].endTime,
            isCombined: true,
          };
        } else {
          // If employee did NOT punch in / track today, return 0 KM and empty coordinates
          const empObj = await User.findById(id).select('name employeeId avatar department');
          session = {
            _id: id,
            employee: empObj || { name: 'Employee' },
            totalDistance: 0,
            coordinates: [],
            isCombined: true,
          };
        }
      }
    }
    if (!session) {
      session = await LiveLocation.findOne({ sessionId: id }).populate('employee', 'name employeeId avatar');
    }
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, session });
  } catch (err) {
    console.error('Get session route error:', err.message);
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

// @desc Get live locations (optimized with server-side caching)
exports.getLiveLocations = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = 'live_locations_all';
    
    // Check cache
    const cachedData = await liveCache.get(cacheKey);
    if (cachedData) {
      return res.json({ success: true, ...cachedData, fromCache: true });
    }
    
    // Get all active tracking sessions
    const activeSessions = await LiveLocation.find({
      isActive: true,
      date: today,
    }).populate('employee', 'name employeeId avatar department');

    // Format for frontend
    const locations = await Promise.all(activeSessions.map(async (session) => {
      const latestCoord = session.coordinates[session.coordinates.length - 1] || {};
      const sessionState = await getSessionState(session.sessionId);

      // Sum up total distance across ALL sessions for this employee today
      const allTodaySessions = await LiveLocation.find({ 
        employee: session.employee._id, 
        date: today 
      });
      const cumulativeDistance = allTodaySessions.reduce((sum, s) => {
        if (s.sessionId === session.sessionId) {
          return sum + (sessionState?.totalDistance ?? s.totalDistance ?? 0);
        }
        return sum + (s.totalDistance || 0);
      }, 0);

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
        totalDistance: Math.round(cumulativeDistance * 100) / 100,
        sessionId: session.sessionId,
        startTime: session.startTime,
        updatedAt: latestCoord.timestamp || session.updatedAt,
      };
    }));

    const responseData = { locations, count: locations.length };
    
    // Store in cache for 10 seconds (very short but helps with burst requests)
    await liveCache.set(cacheKey, responseData, 10);

    res.json({ success: true, ...responseData });
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
// @desc Delete all tracking history for an employee
exports.deleteEmployeeHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    // Optional: Filter by date if needed, but the request says "All history"
    const result = await LiveLocation.deleteMany({ employee: employeeId });
    
    // Log activity
    await ActivityLog.create({
      employee: req.user._id,
      action: 'HISTORY_DELETED',
      description: `Deleted ${result.deletedCount} tracking records for employee ${employeeId}`
    });

    res.json({ 
      success: true, 
      message: `Successfully deleted ${result.deletedCount} history records for this employee.`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
