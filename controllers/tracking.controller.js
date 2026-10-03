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
      organizationId: req.user.organizationId?._id || req.user.organizationId,
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
        organizationId: req.user.organizationId?._id || req.user.organizationId,
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

// AGTRIE-X v7 Advanced Mathematical GPS Tracking Engine - Helpers
function kalmanSmooth(rawLat, rawLng, accuracyM, lastState) {
  const Q = 0.00001;
  const R = Math.pow(Math.max(accuracyM, 5) / 111320, 2);
  if (!lastState) {
    return { lat: rawLat, lng: rawLng, pLat: R, pLng: R };
  }
  const predictedLat = lastState.lat;
  const predictedLng = lastState.lng;
  const predictedPLat = lastState.pLat + Q;
  const predictedPLng = lastState.pLng + Q;
  const kLat = predictedPLat / (predictedPLat + R);
  const kLng = predictedPLng / (predictedPLng + R);
  return {
    lat: predictedLat + kLat * (rawLat - predictedLat),
    lng: predictedLng + kLng * (rawLng - predictedLng),
    pLat: (1 - kLat) * predictedPLat,
    pLng: (1 - kLng) * predictedPLng,
  };
}

function classifyMotionState(speedKmh) {
  if (speedKmh < 1) return 'STATIONARY';
  if (speedKmh < 7) return 'WALKING';
  if (speedKmh < 15) return 'RUNNING';
  if (speedKmh < 40) return 'BIKE';
  return 'VEHICLE';
}

function mahalanobisTest(predicted, observed, covarianceLat, covarianceLng) {
  const dLat = observed.lat - predicted.lat;
  const dLng = observed.lng - predicted.lng;
  const md = Math.sqrt((dLat * dLat) / covarianceLat + (dLng * dLng) / covarianceLng);
  return { md, accepted: md < 10.6 };
}

// @desc Update location (bulk coordinates)
exports.updateLocation = async (req, res) => {
  let releaseSessionLock;
  try {
    const { sessionId, coordinates } = req.body;
    if (!sessionId || !Array.isArray(coordinates) || coordinates.length === 0) {
      return res.status(400).json({ success: false, message: 'sessionId and coordinates are required' });
    }
    releaseSessionLock = await acquireSessionLock(sessionId);

    let sessionState = await getSessionState(sessionId);
    if (!sessionState) {
      const dbSession = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true });
      if (!dbSession) return res.status(404).json({ success: false, message: 'Session not found' });
      const lastCoordDb = dbSession.coordinates[dbSession.coordinates.length - 1] || {};
      sessionState = {
        totalDistance: dbSession.totalDistance || 0,
        lastLat: lastCoordDb.lat || 0,
        lastLng: lastCoordDb.lng || 0,
        lastTs: lastCoordDb.timestamp || new Date().toISOString(),
        kalmanState: dbSession.kalmanState || null,
        lastSpeed: 0,
      };
      await saveSessionState(sessionId, sessionState);
    }

    // Layer 1: Input Validation & Chronological Ordering
    const orderedCoordinates = [...coordinates].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const incomingEventIds = orderedCoordinates.map(c => c?.eventId).filter(Boolean);
    const existingEventIdSet = new Set();
    if (incomingEventIds.length > 0) {
      try {
        const existingDoc = await LiveLocation.findOne(
          { sessionId, employee: req.user._id, 'coordinates.eventId': { $in: incomingEventIds } },
          { 'coordinates.eventId': 1 }
        ).lean();
        if (existingDoc && Array.isArray(existingDoc.coordinates)) {
          existingDoc.coordinates.forEach(c => {
            if (c?.eventId) existingEventIdSet.add(c.eventId);
          });
        }
      } catch (_) {}
    }

    const MAX_SPEED_KMH = 180;
    const MAX_ACCEL_MS2 = 6;
    
    let incrementalDist = 0;
    let newLastLat = sessionState.lastLat;
    let newLastLng = sessionState.lastLng;
    let newLastTs  = sessionState.lastTs;
    let kalmanState = sessionState.kalmanState || null;
    let lastSpeedKmh = sessionState.lastSpeed || 0;
    
    const validCoords = [];
    const rejectionReasons = [];
    
    let totalRawPoints = orderedCoordinates.length;
    let acceptedPoints = 0;
    let recoveredPoints = 0;
    let rejectedPoints = 0;
    let gaps = 0;
    let lostEvents = 0;
    let batchMaxSpeed = 0;
    let sumAccuracy = 0;
    let batchWorstAccuracy = 0;
    
    let currentMotionState = 'STATIONARY';
    const processedPoints = [];
    
    for (let i = 0; i < orderedCoordinates.length; i++) {
      const coord = orderedCoordinates[i];
      const lat = Number(coord?.lat);
      const lng = Number(coord?.lng);
      const timestamp = new Date(coord?.timestamp);
      
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(timestamp.getTime()) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        rejectedPoints++;
        continue;
      }
      
      const normalizedCoord = { ...coord, lat, lng, timestamp: timestamp.toISOString() };
      
      if (coord.eventId && existingEventIdSet.has(coord.eventId)) continue;
      if (coord.isHeartbeat) continue;
      if (newLastTs && timestamp.getTime() <= new Date(newLastTs).getTime()) continue;
      
      const accuracy = Number(coord.accuracy) || 50;
      sumAccuracy += accuracy;
      if (accuracy > batchWorstAccuracy) batchWorstAccuracy = accuracy;
      
      // Layer 2: EKF Smoothing
      kalmanState = kalmanSmooth(lat, lng, accuracy, kalmanState);
      
      const timeDiffSec = newLastTs ? (timestamp.getTime() - new Date(newLastTs).getTime()) / 1000 : 0;
      if (timeDiffSec > 60) gaps++;
      if (accuracy > 100 && timeDiffSec > 30) lostEvents++;
      
      let speedKmh = 0;
      let accelMs2 = 0;
      const rawDist = haversineDistance({ lat: newLastLat, lng: newLastLng }, { lat: kalmanState.lat, lng: kalmanState.lng });
      
      if (timeDiffSec > 0) {
        speedKmh = (rawDist / timeDiffSec) * 3600;
        const speedMs = speedKmh / 3.6;
        const lastSpeedMs = lastSpeedKmh / 3.6;
        accelMs2 = Math.abs(speedMs - lastSpeedMs) / timeDiffSec;
      }
      
      if (speedKmh > batchMaxSpeed) batchMaxSpeed = speedKmh;
      
      // Layer 4: Mahalanobis Test
      const mTest = mahalanobisTest(
        { lat: newLastLat, lng: newLastLng }, 
        { lat: kalmanState.lat, lng: kalmanState.lng },
        kalmanState.pLat || 0.00001,
        kalmanState.pLng || 0.00001
      );
      
      let accepted = true;
      let reason = '';
      
      // Layer 5: Kinematic Validation
      if (speedKmh > MAX_SPEED_KMH) { accepted = false; reason = 'SPEED_EXCEEDED'; }
      else if (accelMs2 > MAX_ACCEL_MS2) { accepted = false; reason = 'ACCEL_EXCEEDED'; }
      else if (newLastTs && !mTest.accepted && timeDiffSec < 10) { accepted = false; reason = 'MAHALANOBIS_FAIL'; }
      
      // Layer 6: Multi-Tier Accuracy Filter
      let pointStatus = 'REJECTED';
      if (accepted) {
        if (accuracy <= 30) pointStatus = 'ACCEPT';
        else if (accuracy <= 100) pointStatus = 'ACCEPT';
        else if (accuracy <= 300) pointStatus = 'CANDIDATE';
        else { pointStatus = 'UNVERIFIED'; accepted = false; reason = 'POOR_ACCURACY'; }
      }
      
      if (!accepted) {
        rejectedPoints++;
        rejectionReasons.push({ timestamp: timestamp, reason, lat, lng, accuracy, speed: speedKmh });
        processedPoints.push({ ...normalizedCoord, kalmanLat: kalmanState.lat, kalmanLng: kalmanState.lng, status: 'REJECTED', rawDist: 0 });
      } else {
        processedPoints.push({ ...normalizedCoord, kalmanLat: kalmanState.lat, kalmanLng: kalmanState.lng, status: pointStatus, rawDist, speedKmh });
      }
    }
    
    // Layer 7: RTS Backward Smoothing Pass
    for (let i = 1; i < processedPoints.length - 1; i++) {
      if (processedPoints[i].status === 'REJECTED') {
        const prev = processedPoints[i-1];
        const next = processedPoints[i+1];
        if (prev.status === 'ACCEPT' && next.status === 'ACCEPT') {
          const t1 = new Date(prev.timestamp).getTime();
          const t3 = new Date(next.timestamp).getTime();
          if (t3 - t1 < 30000) {
            const totalDist = haversineDistance(prev, next);
            const midDist = haversineDistance(prev, processedPoints[i]) + haversineDistance(processedPoints[i], next);
            if (midDist < totalDist * 1.5) {
              processedPoints[i].status = 'RECOVERED';
              recoveredPoints++;
              rejectedPoints--;
            }
          }
        }
      }
    }
    
    // Aggregate Distances
    let segmentUncertainty = 0;
    for (const pt of processedPoints) {
      if (pt.status === 'ACCEPT' || pt.status === 'RECOVERED') {
        if (pt.status === 'ACCEPT') acceptedPoints++;
        incrementalDist += pt.rawDist;
        newLastLat = pt.kalmanLat;
        newLastLng = pt.kalmanLng;
        newLastTs = pt.timestamp;
        lastSpeedKmh = pt.speedKmh || 0;
      }
      validCoords.push(pt);
    }
    
    currentMotionState = classifyMotionState(lastSpeedKmh);
    const runningAvgAccuracy = sumAccuracy / (totalRawPoints || 1);
    const newOfficialTotal = parseFloat((sessionState.totalDistance + incrementalDist).toFixed(3));
    
    await saveSessionState(sessionId, {
      totalDistance: newOfficialTotal,
      lastLat: newLastLat,
      lastLng: newLastLng,
      lastTs: newLastTs,
      kalmanState,
      lastSpeed: lastSpeedKmh
    });

    if (validCoords.length > 0) {
      const lastCoord = validCoords[validCoords.length - 1];
      const tagged = validCoords.map((coord) => ({ ...coord, address: coord.address || '' }));
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        {
          $push: { coordinates: { $each: tagged }, rejectionReasons: { $each: rejectionReasons } },
          $inc: {
            gpsPointCount: totalRawPoints,
            acceptedPointCount: acceptedPoints,
            recoveredPointCount: recoveredPoints,
            rejectedPointCount: rejectedPoints,
            gapCount: gaps,
            gpsLostCount: lostEvents,
          },
          $max: {
            totalDistance: newOfficialTotal,
            officialDistance: newOfficialTotal,
            worstAccuracy: batchWorstAccuracy,
            maxSpeed: batchMaxSpeed,
          },
          $set: {
            lastActivity: new Date(),
            motionState: currentMotionState,
            averageAccuracy: runningAvgAccuracy,
            algorithmVersion: 'AGTRIE-X-v7',
          }
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
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        { $max: { totalDistance: newOfficialTotal } },
        { runValidators: true }
      ).catch(() => {});
    }

    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: newLastLat,
      lng: newLastLng,
      totalDistance: newOfficialTotal,
      sessionId,
      motionState: currentMotionState
    });

    res.json({ 
      success: true, 
      totalDistance: newOfficialTotal, 
      motionState: currentMotionState, 
      audit: { accepted: acceptedPoints, recovered: recoveredPoints, rejected: rejectedPoints, unverified: 0 } 
    });
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
exports.autoStopInactiveSessions = async (io, inactivityMs = 14 * 60 * 60 * 1000) => {
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
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const userScope = isSuperAdmin ? {} : { organizationId: orgId };
    if (userRole === 'MANAGER') {
      userScope.$or = [{ managerId: req.user._id }, { manager: req.user._id }, { _id: req.user._id }];
    }

    const employees = await User.find({ isTracking: true, isOnline: true, ...userScope })
      .select('name employeeId department avatar isTracking isOnline lastSeen');
    
    const empIds = employees.map(e => e._id);
    const locations = await LiveLocation.find({
      isActive: true,
      date: new Date().toISOString().slice(0, 10),
      employee: { $in: empIds }
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

// @desc Get live locations (optimized with server-side caching & tenant isolation)
exports.getLiveLocations = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `live_locations_${isSuperAdmin ? 'all' : orgId || req.user?._id}`;
    
    // Check cache
    const cachedData = await liveCache.get(cacheKey);
    if (cachedData) {
      return res.json({ success: true, ...cachedData, fromCache: true });
    }
    
    // Scope employee IDs to tenant/manager
    const userScope = isSuperAdmin ? {} : { organizationId: orgId };
    if (userRole === 'MANAGER') {
      userScope.$or = [{ managerId: req.user._id }, { manager: req.user._id }, { _id: req.user._id }];
    }

    const orgEmployees = await User.find(userScope).select('_id');
    const empIds = orgEmployees.map(e => e._id);

    // Get active tracking sessions for scoped employees
    const activeSessions = await LiveLocation.find({
      isActive: true,
      date: today,
      employee: { $in: empIds }
    }).populate('employee', 'name employeeId avatar department organizationId');

    // Format for frontend
    const rawLocations = await Promise.all(activeSessions.map(async (session) => {
      if (!session.employee) return null;
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

    const locations = rawLocations.filter(Boolean);
    const responseData = { locations, count: locations.length };
    
    // Store in cache for 10 seconds
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
