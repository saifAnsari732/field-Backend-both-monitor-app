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

// AGTRIE-X v7 State-Space Trajectory Reconstruction Engine
const {
  ENUProjection,
  KinematicKalmanFilter,
  RTSFixedLagSmoother,
  KinematicGapRecoverer,
  DistanceLedger
} = require('../services/trajectoryEngine');

function classifyMotionState(speedKmh) {
  if (speedKmh < 1.0) return 'STATIONARY';
  if (speedKmh < 7.0) return 'WALKING';
  if (speedKmh < 15.0) return 'RUNNING';
  if (speedKmh < 45.0) return 'BIKE';
  return 'VEHICLE';
}

// @desc Update location (bulk coordinates) — AGTRIE-X v7 State-Space Pipeline
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
        kfState: null,
        lastVx: 0,
        lastVy: 0,
        lastSpeed: 0,
      };
      await saveSessionState(sessionId, sessionState);
    }

    // Step 1: Chronological Sorting & Deduplication
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

    // Initialize Local Cartesian ENU Projection anchored at session origin
    const originLat = sessionState.lastLat || orderedCoordinates[0]?.lat || 0;
    const originLng = sessionState.lastLng || orderedCoordinates[0]?.lng || 0;
    const proj = new ENUProjection(originLat, originLng);

    // Initialize 4-State Kinematic Kalman Filter [x, y, vx, vy]^T
    const initEnu = proj.toENU(sessionState.lastLat || originLat, sessionState.lastLng || originLng);
    const kf = new KinematicKalmanFilter(initEnu.x, initEnu.y, 10);
    if (sessionState.kfState) {
      kf.x = [...sessionState.kfState.x];
      kf.P = sessionState.kfState.P.map(r => [...r]);
    }

    // Initialize Distance Conservation Ledger: D_raw = D_accepted + D_recovered + D_rejected + D_unverified
    const ledger = new DistanceLedger(sessionState.totalDistance || 0);

    const forwardStates = [];
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

    let prevTimestamp = sessionState.lastTs ? new Date(sessionState.lastTs).getTime() : 0;
    let prevAnchorPoint = {
      x: kf.x[0],
      y: kf.x[1],
      vx: kf.x[2],
      vy: kf.x[3],
      lat: sessionState.lastLat || originLat,
      lng: sessionState.lastLng || originLng,
      timestamp: sessionState.lastTs || new Date().toISOString()
    };

    // Forward Kinematic Filtering Pass
    for (let i = 0; i < orderedCoordinates.length; i++) {
      const coord = orderedCoordinates[i];
      const lat = Number(coord?.lat);
      const lng = Number(coord?.lng);
      const timestamp = new Date(coord?.timestamp);
      const tMs = timestamp.getTime();

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(tMs) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        rejectedPoints++;
        ledger.addRejected(0);
        continue;
      }

      if (coord.eventId && existingEventIdSet.has(coord.eventId)) continue;
      if (coord.isHeartbeat) continue;
      if (prevTimestamp && tMs <= prevTimestamp) continue;

      const accuracy = Number(coord.accuracy) || 30;
      sumAccuracy += accuracy;
      if (accuracy > batchWorstAccuracy) batchWorstAccuracy = accuracy;

      const dt = prevTimestamp ? Math.max((tMs - prevTimestamp) / 1000, 0.1) : 1.0;
      prevTimestamp = tMs;

      let gapCurveKm = 0;
      let gapConfidence = 0.85;
      if (dt >= 15 && dt <= 600) {
        gaps++;
        const currEnu = proj.toENU(lat, lng);
        const currAnchorPoint = { x: currEnu.x, y: currEnu.y, vx: kf.x[2], vy: kf.x[3], timestamp: timestamp.toISOString() };
        const gapRecovery = KinematicGapRecoverer.reconstructGap(prevAnchorPoint, currAnchorPoint);
        if (gapRecovery.plausible && gapRecovery.recoveredDistanceMeters > 0) {
          const splineKm = gapRecovery.recoveredDistanceMeters / 1000;
          gapCurveKm = splineKm; // Store for curve integration after stepDistKm
          gapConfidence = gapRecovery.confidence;
          recoveredPoints++;
        }
      }

      if (accuracy > 150 && dt > 30) lostEvents++;

      // Kalman Prediction Step: x_pred = F * x, P_pred = F * P * F^T + Q(dt)
      const pred = kf.predict(dt);

      // Convert measurement to local Cartesian ENU
      const zEnu = proj.toENU(lat, lng);

      // Kalman Update Step with reported horizontal accuracy covariance R & Huber gating
      const upd = kf.update(pred, zEnu.x, zEnu.y, accuracy, coord.speed, coord.heading);

      // Speed from filtered velocity vector: v = sqrt(vx^2 + vy^2)
      const speedKmh = Math.hypot(kf.x[2], kf.x[3]) * 3.6;
      if (speedKmh > batchMaxSpeed) batchMaxSpeed = speedKmh;

      if (!upd.accepted) {
        rejectedPoints++;
        ledger.addRejected(0);
        rejectionReasons.push({ timestamp, reason: 'MAHALANOBIS_OUTLIER', lat, lng, accuracy, speed: speedKmh });
        continue;
      }

      // Convert filtered position back to geodetic lat/lng
      const smoothedGeo = proj.toGeo(kf.x[0], kf.x[1]);

      // Calculate incremental step distance using geodetic curvature
      const stepDistKm = haversineDistance(
        { lat: prevAnchorPoint.lat || sessionState.lastLat, lng: prevAnchorPoint.lng || sessionState.lastLng },
        smoothedGeo
      );

      // Multi-tier accuracy validation with distance ledger partitioning
      if (accuracy <= 100) {
        ledger.addAccepted(stepDistKm, accuracy);
        acceptedPoints++;
      } else if (accuracy <= 250) {
        // Recoverable degraded signal: count with uncertainty downweighting
        ledger.addRecovered(stepDistKm, 0.75);
        recoveredPoints++;
      } else {
        // Unverified high-noise GPS (> 250m accuracy)
        ledger.addUnverified(stepDistKm);
      }

      // If a gap spline was computed across dropout, add ONLY the extra road curvature beyond chord
      if (gapCurveKm > stepDistKm) {
        const extraCurveKm = gapCurveKm - stepDistKm;
        ledger.addRecovered(extraCurveKm, gapConfidence);
      }

      // Save state for backward RTS smoother
      forwardStates.push({
        xF: [...kf.x],
        PF: kf.P.map(r => [...r]),
        xPred: pred.x,
        PPred: pred.P,
        dt,
        coord: { ...coord, lat: smoothedGeo.lat, lng: smoothedGeo.lng, timestamp: timestamp.toISOString() }
      });

      prevAnchorPoint = {
        x: kf.x[0],
        y: kf.x[1],
        vx: kf.x[2],
        vy: kf.x[3],
        lat: smoothedGeo.lat,
        lng: smoothedGeo.lng,
        timestamp: timestamp.toISOString()
      };
    }

    // Step 2: Full Rauch-Tung-Striebel (RTS) Fixed-Lag Backward Smoothing Pass
    if (forwardStates.length >= 2) {
      const smoothedStates = RTSFixedLagSmoother.smooth(forwardStates);
      for (let sIdx = 0; sIdx < smoothedStates.length; sIdx++) {
        const sm = smoothedStates[sIdx];
        const smGeo = proj.toGeo(sm.xS[0], sm.xS[1]);
        forwardStates[sIdx].coord.lat = smGeo.lat;
        forwardStates[sIdx].coord.lng = smGeo.lng;
        validCoords.push(forwardStates[sIdx].coord);
      }
    } else {
      forwardStates.forEach(f => validCoords.push(f.coord));
    }

    // Step 3: Compute Strict Distance Conservation Ledger Snapshot
    const snapshot = ledger.getSnapshot();
    const newOfficialTotal = snapshot.officialKm;
    const finalVx = kf.x[2];
    const finalVy = kf.x[3];
    const finalSpeedKmh = Math.hypot(finalVx, finalVy) * 3.6;
    const currentMotionState = classifyMotionState(finalSpeedKmh);
    const runningAvgAccuracy = sumAccuracy / (totalRawPoints || 1);

    const lastGeo = proj.toGeo(kf.x[0], kf.x[1]);

    // Persist Authoritative State to Redis
    await saveSessionState(sessionId, {
      totalDistance: newOfficialTotal,
      lastLat: lastGeo.lat,
      lastLng: lastGeo.lng,
      lastTs: prevAnchorPoint.timestamp,
      kfState: { x: kf.x, P: kf.P },
      lastVx: finalVx,
      lastVy: finalVy,
      lastSpeed: finalSpeedKmh
    });

    // Step 4: MongoDB Atomic Persistence with Full Audit Ledger
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
            rawGpsDistance: snapshot.rawTotalKm,
            acceptedDistance: snapshot.acceptedKm,
            recoveredDistance: snapshot.recoveredKm,
            rejectedDistance: snapshot.rejectedKm,
            unverifiedDistance: snapshot.unverifiedKm,
            distanceUncertainty: snapshot.uncertaintyKm,
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
        { $max: { totalDistance: newOfficialTotal, officialDistance: newOfficialTotal } },
        { runValidators: true }
      ).catch(() => {});
    }

    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: lastGeo.lat,
      lng: lastGeo.lng,
      totalDistance: newOfficialTotal,
      sessionId,
      motionState: currentMotionState
    });

    res.json({ 
      success: true, 
      totalDistance: newOfficialTotal, 
      motionState: currentMotionState, 
      audit: {
        rawGpsDistance: snapshot.rawTotalKm,
        officialDistance: snapshot.officialKm,
        acceptedDistance: snapshot.acceptedKm,
        recoveredDistance: snapshot.recoveredKm,
        rejectedDistance: snapshot.rejectedKm,
        unverifiedDistance: snapshot.unverifiedKm,
        uncertaintyKm: snapshot.uncertaintyKm,
        acceptedPoints,
        recoveredPoints,
        rejectedPoints
      } 
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

    session.officialDistance = session.totalDistance;
    await session.save();

    // Clear Redis session state — shift is over
    await clearSessionState(sessionId);

    await User.findByIdAndUpdate(req.user._id, { isTracking: false });

    // Use session.date so shifts spanning midnight attribute distance to correct attendance day
    const targetDate = session.date || new Date().toISOString().slice(0, 10);
    const allSessions = await LiveLocation.find({ employee: req.user._id, date: targetDate });
    const totalDist = allSessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: targetDate },
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
    
    // Sum total distance across all sessions today for this employee
    const todaySessions = await LiveLocation.find({ employee: session.employee, date: session.date });
    const dayTotalDistance = todaySessions.reduce((acc, s) => acc + (Number(s.totalDistance) || 0), 0);

    await Attendance.findOneAndUpdate(
      { employee: session.employee, date: session.date },
      { $set: { checkOut: new Date(), totalDistanceTraveled: dayTotalDistance } }
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
