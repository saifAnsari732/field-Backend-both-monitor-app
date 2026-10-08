const { LiveLocation, TrackingPoint, DistanceLedger, Attendance, ActivityLog, Notification } = require('../models/index');
const User = require('../models/User.model');
const { v4: uuidv4 } = require('uuid');
const {
  liveCache,
  deleteCache,
  saveSessionState,
  getSessionState,
  incrementSessionDistance,
  clearSessionState,
  acquireDistributedLock,
  checkAndSetIdempotency,
  clearIdempotencyKey
} = require('../services/cache.service');

// Business date (YYYY-MM-DD) in the given timezone (default IST)
function getBusinessDate(date = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// @desc Start tracking session
exports.startTracking = async (req, res) => {
  try {
    const { selfieUrl } = req.body;
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

    // Start geocoding in background to avoid blocking the response
    const addressPromise = hasCoords
      ? Promise.resolve(reverseGeocode(lat, lng)).catch(() => null)
      : Promise.resolve(null);

    const fallbackAddress = hasCoords ? `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})` : 'Location unavailable';
    const address = (await Promise.race([
      addressPromise,
      new Promise(resolve => setTimeout(() => resolve(fallbackAddress), 800))
    ])) || fallbackAddress;

    // Check if employee already has an active session (Punch-In Protection)
    const existingActiveSession = await LiveLocation.findOne({
      employee: req.user._id,
      isActive: true,
    }).sort({ createdAt: -1 });

    if (existingActiveSession) {
      const sessionDate = existingActiveSession.date;
      if (sessionDate && sessionDate !== today) {
        console.log(`📍 startTracking: Closing stale multi-day session ${existingActiveSession.sessionId} from ${sessionDate}`);
        await LiveLocation.findByIdAndUpdate(existingActiveSession._id, {
          isActive: false,
          endTime: new Date(),
        });
        await clearSessionState(existingActiveSession.sessionId);
      } else {
        console.log(`📍 startTracking: Re-attaching to existing active session ${existingActiveSession.sessionId}`);
        await User.findByIdAndUpdate(req.user._id, { isTracking: true });
        return res.status(200).json({
          success: true,
          message: 'Active shift already exists. Reconnected.',
          sessionId: existingActiveSession.sessionId,
          totalDistance: existingActiveSession.totalDistance || 0,
          totalDistanceToday: existingActiveSession.totalDistance || 0,
          startTime: existingActiveSession.startTime,
          session: existingActiveSession,
        });
      }
    }

    const session = await LiveLocation.create({
      organizationId: req.user.organizationId?._id || req.user.organizationId,
      employee: req.user._id,
      sessionId: uuidv4(),
      coordinates: hasCoords ? [{ lat, lng, timestamp: new Date(), address }] : [],
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
      lastLat: hasCoords ? lat : null,
      lastLng: hasCoords ? lng : null,
      lastTs: new Date().toISOString(),
    });

    // Invalidate live location caches
    const userOrgId = req.user.organizationId?._id || req.user.organizationId;
    if (userOrgId) await deleteCache(`live_locations_${userOrgId}`);
    await deleteCache(`live_locations_${req.user._id}`);
    await deleteCache('live_locations_all');

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

    // Calculate employee's total distance today across all sessions
    const allTodaySessions = await LiveLocation.find({ employee: req.user._id, date: today });
    const totalDistanceToday = allTodaySessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    res.json({ 
      success: true, 
      session, 
      totalDistanceToday: Math.round(totalDistanceToday * 100) / 100 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const { reverseGeocode } = require('../services/geocode.service');
const { snapToRoads } = require('../services/roads.service');

// AGTRIE-X 5.0 Advanced Mathematical GPS Engine
const {
  ENUProjection,
  KinematicKalmanFilter,
  IMMMotionEstimator,
  BayesianGPSScorer,
  RTSFixedLagSmoother,
  KinematicGapRecoverer,
  DistanceLedgerCalculator,
  haversineM
} = require('../services/trajectoryEngine');

// ─── Motion State Classifier (AGTRIE-X v7) ────────────────────────────────
function classifyMotionState(speedKmh) {
  if (speedKmh < 1) return 'STATIONARY';
  if (speedKmh < 7) return 'WALKING';
  if (speedKmh < 15) return 'RUNNING';
  if (speedKmh < 40) return 'BIKE';
  if (speedKmh <= 220) return 'VEHICLE';
  return 'UNKNOWN';
}

// Re-open a session whenever live telemetry arrives for it.
async function reopenIfAutoClosed(sessionId, employeeId) {
  const doc = await LiveLocation.findOneAndUpdate(
    { sessionId, employee: employeeId },
    { $set: { isActive: true, autoClosed: false, lastActivity: new Date() }, $unset: { endTime: 1 } },
    { new: true }
  );
  if (!doc) return false;
  await User.findByIdAndUpdate(employeeId, { isTracking: true, isOnline: true });
  const today = new Date().toISOString().slice(0, 10);
  await Attendance.findOneAndUpdate({ employee: employeeId, date: today }, { $unset: { checkOut: 1 } }).catch(() => {});
  console.log(`[tracking] Auto-reactivated session ${sessionId} for employee ${employeeId}`);
  return true;
}

// @desc Update location (bulk coordinates) — AGTRIE-X v7 State-Space Pipeline
exports.updateLocation = async (req, res) => {
  let releaseSessionLock;
  try {
    const { sessionId, coordinates } = req.body;
    if (!sessionId || !Array.isArray(coordinates) || coordinates.length === 0) {
      return res.status(400).json({ success: false, message: 'sessionId and coordinates are required' });
    }

    const orgId = req.user.organizationId?._id || req.user.organizationId;

    // ─── GOLDEN RULE: SAVE RAW GPS TELEMETRY FIRST ───────────────────────────
    // Every raw GPS fix is saved to TrackingPoint BEFORE calculation
    const rawBatch = coordinates.map((c) => {
      const ts = c?.timestamp ? new Date(c.timestamp) : new Date();
      const eventId = c?.eventId || `${sessionId}:${ts.getTime()}:${Number(c?.lat).toFixed(6)}:${Number(c?.lng).toFixed(6)}`;
      return {
        updateOne: {
          filter: { sessionId, eventId },
          update: {
            $setOnInsert: {
              organizationId: orgId,
              employee: req.user._id,
              sessionId,
              eventId,
              timestamp: ts,
              receivedAt: new Date(),
              lat: Number(c.lat),
              lng: Number(c.lng),
              accuracy: Number(c.accuracy) || 0,
              speed: Number(c.speed) || 0,
              heading: Number(c.heading) || 0,
              altitude: Number(c.altitude) || 0,
              provider: c.provider || 'gps',
              processingStatus: 'PENDING',
              algorithmVersion: 'AGTRIE-X-v7-DURABLE'
            }
          },
          upsert: true
        }
      };
    });

    if (rawBatch.length > 0) {
      try {
        await TrackingPoint.bulkWrite(rawBatch, { ordered: false });
      } catch (rawStoreErr) {
        console.error('❌ [RAW_GPS_STORE_ERROR] Failed to persist raw GPS telemetry:', rawStoreErr.message);
        return res.status(500).json({ 
          success: false, 
          message: 'Raw GPS persistence failed. Request will be retried by mobile offline queue.',
          retryable: true 
        });
      }
    }

    releaseSessionLock = await acquireDistributedLock(sessionId, 6000);

    // Verify session in MongoDB. If closed or missing, auto-reactivate or auto-adopt on the fly!
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    let activeDoc = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    
    // Multi-Day Zombie Session Auto-Close Guard:
    // If activeDoc belongs to a previous date, auto-close yesterday's shift and start a fresh session for today!
    if (activeDoc && activeDoc.date && activeDoc.date !== today) {
      activeDoc.isActive = false;
      activeDoc.endTime = activeDoc.lastActivity || new Date(`${activeDoc.date}T23:59:59.999Z`);
      await activeDoc.save();
      console.log(`🛡️ [DATE_ROLLOVER] Auto-closed yesterday session ${sessionId} from ${activeDoc.date} for employee ${req.user._id}`);
      activeDoc = null;
    }

    if (!activeDoc) {
      activeDoc = await LiveLocation.findOne({ employee: req.user._id, isActive: true, date: today }).sort({ createdAt: -1 });
      if (!activeDoc) {
        activeDoc = await LiveLocation.create({
          organizationId: orgId,
          employee: req.user._id,
          sessionId: sessionId,
          coordinates: [],
          isActive: true,
          date: today,
          startTime: new Date(),
          startAddress: 'Auto-Adopted Live Shift'
        });
      }
    }

    if (!activeDoc.isActive) {
      activeDoc.isActive = true;
      activeDoc.autoClosed = false;
      activeDoc.lastActivity = new Date();
      await activeDoc.save();
      console.log(`🛡️ [AUTO_RESUME] Auto-reactivated session ${sessionId} for ${req.user.name || req.user._id}`);
    }
    await User.findByIdAndUpdate(req.user._id, { isTracking: true, isOnline: true, lastSeen: new Date() });

    let sessionState = await getSessionState(sessionId);
    if (!sessionState) {
      const dbSession = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true });
      if (!dbSession) return res.status(404).json({ success: false, message: 'Session not found', sessionClosed: true });
      const lastCoordDb = dbSession.coordinates[dbSession.coordinates.length - 1] || {};
      sessionState = {
        totalDistance: dbSession.totalDistance || 0,
        manualDistanceAdded: dbSession.manualDistanceAdded || 0,
        date: dbSession.date,
        lastLat: lastCoordDb.lat || 0,
        lastLng: lastCoordDb.lng || 0,
        lastTs: lastCoordDb.timestamp || new Date().toISOString(),
        lastEventId: lastCoordDb.eventId || null,
        kfState: null,
        lastVx: 0,
        lastVy: 0,
        lastSpeed: 0,
      };
      await saveSessionState(sessionId, sessionState);
    }

    // Step 1: Chronological Sorting & Durable Idempotency Gate
    const orderedCoordinates = [...coordinates].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Durable Idempotency Gate (drops duplicate retries only if already committed to DistanceLedger)
    const incomingEventIds = [];
    const nonDuplicateCoordinates = [];
    for (const c of orderedCoordinates) {
      if (c?.eventId) {
        const isNewInRedis = await checkAndSetIdempotency(sessionId, c.eventId);
        if (!isNewInRedis) {
          // Verify if this event was actually committed into DistanceLedger
          const alreadyCommitted = await DistanceLedger.exists({ sessionId, toEventId: c.eventId });
          if (alreadyCommitted) continue; // Safely skip truly duplicate committed point
        }
        incomingEventIds.push(c.eventId);
      }
      nonDuplicateCoordinates.push(c);
    }

    if (nonDuplicateCoordinates.length === 0) {
      if (typeof releaseSessionLock === 'function') await releaseSessionLock();
      return res.json({ success: true, totalDistance: sessionState.totalDistance || 0, duplicate: true });
    }

    // Secondary Durable Mongo Idempotency check
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

    // Initialize Geodetic 2D Kalman Filter state from sessionState
    let filterLat = Number(sessionState.lastLat) || Number(nonDuplicateCoordinates[0]?.lat) || 0;
    let filterLng = Number(sessionState.lastLng) || Number(nonDuplicateCoordinates[0]?.lng) || 0;
    let filterPLat = Number(sessionState.pLat) || 0.00000001;
    let filterPLng = Number(sessionState.pLng) || 0.00000001;

    // Reconcile any Admin Manual Adjustment from MongoDB in real-time
    const dbLiveDoc = await LiveLocation.findOne(
      { sessionId, employee: req.user._id, isActive: true },
      { totalDistance: 1, manualDistanceAdded: 1, date: 1 }
    ).lean();

    const dbManualAdded = Number(dbLiveDoc?.manualDistanceAdded) || 0;
    const cachedManualAdded = Number(sessionState.manualDistanceAdded) || 0;

    let currentTotalDistance = Number(sessionState.totalDistance) || 0;

    // If an Admin credited or adjusted KM from the Web Monitoring portal during this active shift, apply the delta
    if (Math.abs(dbManualAdded - cachedManualAdded) > 0.001) {
      const manualDelta = dbManualAdded - cachedManualAdded;
      currentTotalDistance = Math.max(0, currentTotalDistance + manualDelta);
      sessionState.manualDistanceAdded = dbManualAdded;
      sessionState.totalDistance = currentTotalDistance;
    }

    let prevTimestamp = sessionState.lastTs ? new Date(sessionState.lastTs).getTime() : 0;
    let lastValidLat = filterLat;
    let lastValidLng = filterLng;
    let lastEventId = sessionState.lastEventId || null;

    const validCoords = [];
    const rejectionReasons = [];
    const ledgerSegments = [];
    const acceptedEventIds = [];
    const rejectedEventIds = [];

    let totalRawPoints = nonDuplicateCoordinates.length;
    let acceptedPoints = 0;
    let rejectedPoints = 0;
    let batchMaxSpeed = 0;
    let sumAccuracy = 0;
    let batchWorstAccuracy = 0;

    let prev2Valid = null;
    let prevValid = { lat: lastValidLat, lng: lastValidLng, timestamp: new Date(prevTimestamp || Date.now()).toISOString(), heading: null };

    // Forward Geodetic Bayesian Kinematic Filtering Pass (AGTRIE-X 5.0)
    for (let i = 0; i < nonDuplicateCoordinates.length; i++) {
      const coord = nonDuplicateCoordinates[i];
      const lat = Number(coord?.lat);
      const lng = Number(coord?.lng);
      const timestamp = new Date(coord?.timestamp);
      const tMs = timestamp.getTime();
      const eventId = coord?.eventId || `${sessionId}:${tMs}:${lat.toFixed(6)}:${lng.toFixed(6)}`;

      // 1. Strict Geographic Boundary Gate (India: Lat 6 to 38, Lng 68 to 98)
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(tMs) || lat < 6 || lat > 38 || lng < 68 || lng > 98) {
        rejectedPoints++;
        rejectedEventIds.push(eventId);
        rejectionReasons.push({
          timestamp,
          reason: 'OUT_OF_BOUNDS_COORDINATE',
          lat, lng, accuracy: coord?.accuracy, speed: coord?.speed
        });
        continue;
      }

      // 2. Fraud / Anti-Spoofing: Reject fake GPS / mock locations
      if (coord?.mocked === true || coord?.isMock === true) {
        rejectedPoints++;
        rejectedEventIds.push(eventId);
        rejectionReasons.push({
          timestamp,
          reason: 'MOCK_LOCATION_DETECTED',
          lat, lng, accuracy: coord.accuracy, speed: coord.speed
        });
        continue;
      }

      if (coord.eventId && existingEventIdSet.has(coord.eventId)) continue;
      if (coord.isHeartbeat) {
        acceptedEventIds.push(eventId);
        continue;
      }
      if (prevTimestamp && tMs <= prevTimestamp) continue;

      const accuracy = Number(coord.accuracy) || 30;
      sumAccuracy += accuracy;
      if (accuracy > batchWorstAccuracy) batchWorstAccuracy = accuracy;

      // Ensure dt is calculated strictly against the last trusted anchor timestamp
      const lastTrustedMs = prevValid?.timestamp ? new Date(prevValid.timestamp).getTime() : (prevTimestamp || tMs - 1000);
      const dt = Math.max((tMs - lastTrustedMs) / 1000, 0.5);

      // 3. Master Bayesian GPS Scoring (AGTRIE-X 5.0)
      const bayesianResult = BayesianGPSScorer.scorePoint(
        { lat, lng, accuracy, speed: coord.speed, heading: coord.heading, timestamp: coord.timestamp },
        prevValid,
        prev2Valid
      );

      // Snapshot filter so a rejected outlier can never contaminate the state
      const snap = { lat: filterLat, lng: filterLng, pLat: filterPLat, pLng: filterPLng };

      // 4. Geodetic 2D Kalman Filter Update
      const R = Math.pow(Math.max(accuracy, 5) / 111320, 2);
      if (dt > 1800) {
        // ── 30-MINUTE / LONG STATIONARY RE-ANCHORING ────────────────────────────
        // Reset filter directly on fresh observation to eliminate covariance lag.
        // CRITICAL P0 FIX: Advance prevValid & prev2Valid to establish the new trusted anchor,
        // preventing infinite loop of dt > 1800 on subsequent 10s telemetry updates!
        filterLat = lat;
        filterLng = lng;
        filterPLat = R;
        filterPLng = R;
        lastValidLat = lat;
        lastValidLng = lng;
        lastEventId = eventId;
        prevTimestamp = tMs;

        const toKmh = (s) => (Number(s) > 0 ? (Number(s) <= 60 ? Number(s) * 3.6 : Number(s)) : 0);
        const reportedSpeedKmh = toKmh(coord.speed);

        prev2Valid = prevValid;
        prevValid = {
          lat: filterLat,
          lng: filterLng,
          latRaw: lat,
          lngRaw: lng,
          accuracy,
          speedKmh: reportedSpeedKmh,
          timestamp: timestamp.toISOString(),
          heading: coord.heading
        };

        acceptedEventIds.push(eventId);
        continue;
      } else {
        const Q = 0.0000001 * Math.min(dt, 30);
        const predPLat = filterPLat + Q;
        const predPLng = filterPLng + Q;
        const kLat = predPLat / (predPLat + R);
        const kLng = predPLng / (predPLng + R);
        filterLat = filterLat + kLat * (lat - filterLat);
        filterLng = filterLng + kLng * (lng - filterLng);
        filterPLat = (1 - kLat) * predPLat;
        filterPLng = (1 - kLng) * predPLng;
      }

      // 5. Raw Segment Distance & Kinematic Calculations
      const dRawKm = prevValid
        ? haversineDistance(
            { lat: prevValid.latRaw ?? prevValid.lat, lng: prevValid.lngRaw ?? prevValid.lng },
            { lat, lng }
          )
        : 0;
      const distM = dRawKm * 1000;

      const toKmh = (s) => (Number(s) > 0 ? (Number(s) <= 60 ? Number(s) * 3.6 : Number(s)) : 0);
      const reportedSpeedKmh = toKmh(coord.speed);
      const rawCalcSpeedKmh = dt > 0 ? (dRawKm / dt) * 3600 : 0;
      const effectiveSpeedKmh = reportedSpeedKmh > 0 ? Math.max(reportedSpeedKmh, rawCalcSpeedKmh) : rawCalcSpeedKmh;

      if (effectiveSpeedKmh > batchMaxSpeed && effectiveSpeedKmh <= 160) {
        batchMaxSpeed = effectiveSpeedKmh;
      }

      // 6. High-Fidelity Movement vs Stationary Drift Gate
      // Stationary jitter: displacement < 3.0m
      const isStationaryDrift = (distM < 3.0);
      const isTeleportation = effectiveSpeedKmh > 180.0;
      const isMathematicallyValidMovement = !isStationaryDrift && !isTeleportation && dRawKm > 0 && dt <= 1800;

      if (isMathematicallyValidMovement) {
        acceptedPoints++;
        acceptedEventIds.push(eventId);
        prevTimestamp = tMs;

        // Record into immutable DistanceLedger with guaranteed non-null fromEventId
        const safeFromEventId = lastEventId || (prevValid?.timestamp ? `${sessionId}:${new Date(prevValid.timestamp).getTime()}` : `${sessionId}:start`);
        ledgerSegments.push({
          organizationId: orgId,
          employee: req.user._id,
          sessionId,
          fromEventId: safeFromEventId,
          toEventId: eventId,
          fromTimestamp: new Date(lastTrustedMs),
          toTimestamp: timestamp,
          fromLat: prevValid?.latRaw ?? lastValidLat,
          fromLng: prevValid?.lngRaw ?? lastValidLng,
          toLat: lat,
          toLng: lng,
          distanceMeters: Math.round(dRawKm * 1000),
          distanceKm: Math.round(dRawKm * 1000) / 1000,
          classification: 'ACCEPTED',
          reason: 'AGTRIE_X_V10_RAW_GEODESIC_ACCEPTED',
          algorithmVersion: 'AGTRIE-X-v10.0-PRO'
        });

        prev2Valid = prevValid;
        prevValid = { lat: filterLat, lng: filterLng, latRaw: lat, lngRaw: lng, accuracy, speedKmh: reportedSpeedKmh, timestamp: timestamp.toISOString(), heading: coord.heading };
        lastValidLat = filterLat;
        lastValidLng = filterLng;
        lastEventId = eventId;
      } else if (isStationaryDrift) {
        // Advance anchor position and timestamp without adding distance to prevent stuck anchor drift
        lastValidLat = filterLat;
        lastValidLng = filterLng;
        lastEventId = eventId;
        if (prevValid) {
          prevValid = {
            ...prevValid,
            timestamp: timestamp.toISOString(),
            lat: filterLat,
            lng: filterLng,
            latRaw: lat,
            lngRaw: lng
          };
        }
        prevTimestamp = tMs;
        acceptedEventIds.push(eventId);
      } else {
        // GPS outlier / teleportation > 180 km/h: REJECT without contaminating trusted anchor
        lastValidLat = filterLat;
        lastValidLng = filterLng;
        rejectedPoints++;
        rejectedEventIds.push(eventId);
        rejectionReasons.push({
          timestamp,
          reason: 'TELEPORTATION_OR_STEP_LIMIT_EXCEEDED',
          lat, lng, accuracy, speed: effectiveSpeedKmh
        });
      }

      validCoords.push({
        ...coord,
        eventId,
        lat: filterLat,
        lng: filterLng,
        timestamp: timestamp.toISOString()
      });
    }

    // Persist DistanceLedger segments to MongoDB (Immutable Audit Ledger)
    if (ledgerSegments.length > 0) {
      try {
        await DistanceLedger.insertMany(ledgerSegments, { ordered: false });
      } catch (ledgerErr) {
        if (ledgerErr.code === 11000 || ledgerErr.name === 'MongoBulkWriteError' || (ledgerErr.message && ledgerErr.message.includes('E11000'))) {
          console.log(`ℹ️ [DISTANCE_LEDGER] Duplicate segment key ignored for session ${sessionId}`);
        } else {
          console.error('❌ [DISTANCE_LEDGER_ERROR] Failed to persist distance ledger:', ledgerErr.message);
          try {
            await TrackingPoint.updateMany(
              { sessionId, eventId: { $in: ledgerSegments.map(x => x.toEventId) } },
              { $set: { processingStatus: 'PENDING' } }
            );
          } catch (_) {}
          if (typeof releaseSessionLock === 'function') await releaseSessionLock();
          return res.status(503).json({
            success: false,
            retryable: true,
            message: 'GPS stored but distance processing is pending'
          });
        }
      }
    }

    // Derive authoritative session total directly from immutable DistanceLedger (ACCEPTED + RECOVERED segments)
    const ledgerAgg = await DistanceLedger.aggregate([
      { $match: { sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
      { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
    ]);
    const ledgerKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
    const liveDocLatest = await LiveLocation.findOne({ sessionId, employee: req.user._id }).select('totalDistance manualDistanceAdded').lean();
    const prevDist = Math.max(Number(sessionState.totalDistance) || 0, Number(liveDocLatest?.totalDistance) || 0);

    // Monotonic non-decreasing guarantee: distance can NEVER drop to 0 if travel has occurred
    currentTotalDistance = Math.round(Math.max(prevDist, ledgerKm) * 100) / 100;

    // Bulk update TrackingPoint statuses
    if (acceptedEventIds.length > 0) {
      TrackingPoint.updateMany(
        { sessionId, eventId: { $in: acceptedEventIds } },
        { $set: { processingStatus: 'ACCEPTED' } }
      ).catch(() => {});
    }
    if (rejectedEventIds.length > 0) {
      TrackingPoint.updateMany(
        { sessionId, eventId: { $in: rejectedEventIds } },
        { $set: { processingStatus: 'REJECTED' } }
      ).catch(() => {});
    }

    const finalSpeedKmh = Math.min(batchMaxSpeed, 220);
    const currentMotionState = classifyMotionState(finalSpeedKmh);
    const runningAvgAccuracy = sumAccuracy / (totalRawPoints || 1);

    // Throttle reverse geocoding: only resolve address if movement >= 250m or >= 5 minutes since last geocode
    let shouldGeocode = false;
    let lastGeocodeTs = sessionState.lastGeocodeTs || 0;
    let lastGeocodeLat = sessionState.lastGeocodeLat || 0;
    let lastGeocodeLng = sessionState.lastGeocodeLng || 0;

    if (validCoords.length > 0) {
      const lastCoord = validCoords[validCoords.length - 1];
      const nowMs = Date.now();
      const distFromLastGeo = (lastGeocodeLat && lastGeocodeLng)
        ? Math.hypot(lastCoord.lat - lastGeocodeLat, lastCoord.lng - lastGeocodeLng) * 111320
        : 9999;

      if (distFromLastGeo >= 250 || (nowMs - lastGeocodeTs) >= 5 * 60 * 1000) {
        shouldGeocode = true;
        lastGeocodeTs = nowMs;
        lastGeocodeLat = lastCoord.lat;
        lastGeocodeLng = lastCoord.lng;
      }
    }

    // Persist Authoritative State to Redis
    await saveSessionState(sessionId, {
      totalDistance: currentTotalDistance,
      manualDistanceAdded: dbManualAdded,
      date: sessionState.date || dbLiveDoc?.date,
      lastLat: lastValidLat,
      lastLng: lastValidLng,
      lastTs: new Date(prevValid?.timestamp || sessionState.lastTs || Date.now()).toISOString(),
      lastEventId,
      pLat: filterPLat,
      pLng: filterPLng,
      lastSpeed: finalSpeedKmh,
      lastGeocodeTs,
      lastGeocodeLat,
      lastGeocodeLng
    });

    // Step 4: MongoDB Atomic Persistence with Full Audit Ledger
    if (validCoords.length > 0) {
      const lastCoord = validCoords[validCoords.length - 1];
      const tagged = validCoords.map((coord) => ({ ...coord, address: coord.address || '' }));
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        {
          $push: { 
            coordinates: { $each: tagged, $slice: -500 }, 
            rejectionReasons: { $each: rejectionReasons, $slice: -100 } 
          },
          $inc: {
            gpsPointCount: totalRawPoints,
            acceptedPointCount: acceptedPoints,
            rejectedPointCount: rejectedPoints,
          },
          $max: {
            worstAccuracy: batchWorstAccuracy,
            maxSpeed: batchMaxSpeed,
          },
          $set: {
            totalDistance: currentTotalDistance,
            officialDistance: currentTotalDistance,
            acceptedDistance: currentTotalDistance,
            rawGpsDistance: currentTotalDistance,
            manualDistanceAdded: dbManualAdded,
            lastActivity: new Date(),
            motionState: currentMotionState,
            averageAccuracy: runningAvgAccuracy,
            algorithmVersion: 'AGTRIE-X-v7.2-DURABLE',
          }
        },
        { runValidators: true }
      );

      if (shouldGeocode) {
        reverseGeocode(lastCoord.lat, lastCoord.lng).then((address) => {
          if (!address) return;
          return LiveLocation.updateOne(
            { sessionId, employee: req.user._id, isActive: true },
            { $set: { 'coordinates.$[point].address': address } },
            { arrayFilters: [{ 'point.eventId': lastCoord.eventId }] }
          );
        }).catch(() => {});
      }
    } else {
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id, isActive: true },
        {
          $set: {
            totalDistance: currentTotalDistance,
            officialDistance: currentTotalDistance,
            manualDistanceAdded: dbManualAdded,
            lastActivity: new Date(),
          }
        },
        { runValidators: true }
      ).catch(() => {});
    }

    // Reconcile and update Attendance.totalDistanceTraveled from authoritative clean trajectory distance
    const targetDate = sessionState.date || dbLiveDoc?.date || new Date().toISOString().slice(0, 10);
    const roundedDayKm = currentTotalDistance;

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: targetDate },
      { $set: { totalDistanceTraveled: roundedDayKm } }
    ).catch(() => {});

    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: lastValidLat,
      lng: lastValidLng,
      totalDistance: roundedDayKm,
      sessionDistance: currentTotalDistance,
      sessionId,
      motionState: currentMotionState
    });

    // Invalidate live location & dashboard caches so admin/manager UI updates instantly
    if (orgId) {
      await deleteCache(`live_locations_${orgId}`).catch(() => {});
      await deleteCache(`admin_dashboard_${orgId}`).catch(() => {});
    }
    await deleteCache(`live_locations_${req.user._id}`).catch(() => {});
    await deleteCache('live_locations_all').catch(() => {});

    res.json({ 
      success: true, 
      totalDistance: currentTotalDistance, 
      totalDistanceToday: roundedDayKm,
      motionState: currentMotionState, 
      audit: {
        rawGpsDistance: currentTotalDistance,
        officialDistance: currentTotalDistance,
        acceptedDistance: currentTotalDistance,
        acceptedPoints,
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

    let session = null;
    if (sessionId) {
      session = await LiveLocation.findOne({ sessionId, employee: req.user._id });
    }
    if (!session) {
      session = await LiveLocation.findOne({ employee: req.user._id, isActive: true }).sort({ createdAt: -1 });
    }
    if (!session) {
      session = await LiveLocation.findOne({ employee: req.user._id }).sort({ createdAt: -1 });
    }

    if (!session) {
      await User.findByIdAndUpdate(req.user._id, { isTracking: false });
      return res.json({ success: true, totalDistance: 0, message: 'No active session found; tracking reset.' });
    }

    const effectiveSessionId = session.sessionId || sessionId;

    // Get final authoritative distance from Redis before clearing
    const cachedState = await getSessionState(effectiveSessionId);
    const redisTotalDist = cachedState ? cachedState.totalDistance : null;

    session.isActive = false;
    session.endTime = new Date();

    // Pure GPS distance from the AGTRIE-X engine (100% strict 1:1 GPS distance)
    const baseGpsKm = Math.max(
      Number(session.totalDistance) || 0,
      Number(redisTotalDist) || 0
    );
    const gpsKm = Math.round(baseGpsKm * 100) / 100;

    // Zero extra tolerance addition — strict 1:1 GPS distance policy
    const TOLERANCE_PCT = Number(process.env.PUNCH_OUT_TOLERANCE_PCT ?? 0);
    const toleranceKm = (gpsKm > 0 && TOLERANCE_PCT > 0) ? Math.round(gpsKm * (TOLERANCE_PCT / 100) * 100) / 100 : 0;
    const finalOfficialKm = Math.round((gpsKm + toleranceKm) * 100) / 100;

    session.acceptedDistance = gpsKm;       // pure GPS km
    session.rawGpsDistance = gpsKm;
    session.totalDistance = finalOfficialKm;
    session.officialDistance = finalOfficialKm;
    if (toleranceKm > 0) {
      session.manualDistanceAdded = Math.round(((Number(session.manualDistanceAdded) || 0) + toleranceKm) * 100) / 100;
      session.manualAdjustmentReason = `${TOLERANCE_PCT}% Punch Out tolerance: GPS ${gpsKm} km + ${toleranceKm} km = ${finalOfficialKm} km`;
    }

    // Get end address from last coordinate
    if (session.coordinates && session.coordinates.length > 0) {
      session.endAddress = session.coordinates[session.coordinates.length - 1].address;
    }

    await session.save();

    // Clear Redis session state — shift is over
    await User.findByIdAndUpdate(req.user._id, { isTracking: false });

    // Ensure all active sessions for this employee are closed
    await LiveLocation.updateMany(
      { employee: req.user._id, isActive: true },
      { $set: { isActive: false, endTime: new Date() } }
    );

    // Invalidate live location caches so dashboard immediately removes the stopped employee
    const userOrgId = req.user.organizationId?._id || req.user.organizationId;
    if (userOrgId) await deleteCache(`live_locations_${userOrgId}`);
    await deleteCache(`live_locations_${req.user._id}`);
    await deleteCache('live_locations_all');

    // Use session.date so shifts spanning midnight attribute distance to correct attendance day
    const targetDate = session.date || new Date().toISOString().slice(0, 10);
    const allSessions = await LiveLocation.find({ employee: req.user._id, date: targetDate });
    const totalDist = allSessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    const attRecord = await Attendance.findOne({ employee: req.user._id, date: targetDate });
    if (attRecord) {
      const checkInTime = attRecord.checkIn ? new Date(attRecord.checkIn).getTime() : Date.now();
      const workHours = Math.max(0, (Date.now() - checkInTime) / (1000 * 60 * 60));
      attRecord.checkOut = new Date();
      attRecord.totalWorkHours = Math.round(workHours * 100) / 100;
      attRecord.totalDistanceTraveled = Math.round(totalDist * 100) / 100;
      await attRecord.save();
    } else {
      await Attendance.create({
        organizationId: req.user.organizationId?._id || req.user.organizationId,
        employee: req.user._id,
        date: targetDate,
        checkIn: session.startTime || new Date(),
        checkOut: new Date(),
        totalWorkHours: Math.round(Math.max(0, (Date.now() - (session.startTime ? new Date(session.startTime).getTime() : Date.now())) / (1000 * 60 * 60)) * 100) / 100,
        totalDistanceTraveled: Math.round(totalDist * 100) / 100,
        status: 'present'
      });
    }

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

// [PERMANENT ZERO DATA LOSS POLICY]: Auto-stop policy is disabled.
// Sessions are NEVER auto-stopped. Only explicit Punch Out / Admin Force Close closes a shift.
exports.autoStopInactiveSessions = async (io, inactivityMs = 3 * 60 * 60 * 1000) => {
  // No-op: zero data loss policy. Sessions remain active indefinitely.
  return;
};

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
// Mobile app calls this every ~8 minutes while the employee is stationary.
// Resets lastActivity so the 3-hour auto-stop cron doesn't fire on standing workers.
// Does NOT add distance (idempotent, safe to call multiple times).
exports.heartbeat = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId required' });

    let updated = await LiveLocation.findOneAndUpdate(
      { sessionId, employee: req.user._id, isActive: true },
      { $set: { lastActivity: new Date() } },
      { new: true, select: 'totalDistance isActive' }
    );

    if (!updated && await reopenIfAutoClosed(sessionId, req.user._id)) {
      updated = await LiveLocation.findOne({ sessionId, employee: req.user._id, isActive: true }).select('totalDistance isActive');
    }

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

    let totalDistanceToday = 0;
    const { DistanceLedger } = require('../models/index');
    const sanitizedSessions = await Promise.all((sessions || []).map(async (doc) => {
      const s = doc.toObject ? doc.toObject() : { ...doc };
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: s.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      let sessionDist = 0;
      if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        sessionDist = Math.round(ledgerAgg[0].totalKm * 100) / 100;
      } else {
        sessionDist = Math.round((Number(s.totalDistance) || 0) * 100) / 100;
      }
      s.totalDistance = sessionDist;
      s.officialDistance = sessionDist;
      totalDistanceToday += sessionDist;
      return s;
    }));
    totalDistanceToday = Math.round(totalDistanceToday * 100) / 100;

    res.json({ success: true, sessions: sanitizedSessions, totalDistanceToday });
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
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [daySessions, attRecord, empObj] = await Promise.all([
          LiveLocation.find({ 
            employee: id, 
            $or: [{ date: today }, { createdAt: { $gte: startOfToday } }, { isActive: true }] 
          })
            .sort({ startTime: 1 })
            .populate('employee', 'name employeeId avatar department'),
          Attendance.findOne({ 
            employee: id, 
            $or: [{ date: today }, { createdAt: { $gte: startOfToday } }] 
          }).lean(),
          User.findById(id).select('name employeeId avatar department phone address')
        ]);

        if (daySessions && daySessions.length > 0) {
          let cumulativeDistance = 0;
          let combinedCoordinates = [];

          daySessions.forEach((s) => {
            cumulativeDistance += Number(s.totalDistance) || Number(s.officialDistance) || 0;
            if (Array.isArray(s.coordinates)) {
              combinedCoordinates.push(...s.coordinates);
            }
          });

          const maxDist = Math.max(
            cumulativeDistance,
            Number(attRecord?.totalDistanceTraveled) || 0
          );

          const firstSess = daySessions[0];
          session = {
            _id: id,
            employee: firstSess.employee || empObj,
            totalDistance: Math.round(maxDist * 100) / 100,
            coordinates: combinedCoordinates,
            startTime: firstSess.startTime,
            endTime: daySessions[daySessions.length - 1].endTime,
            isActive: daySessions.some(s => s.isActive),
            isCombined: true,
          };
        } else {
          // Check if employee has a previous recent session
          const latestPastSession = await LiveLocation.findOne({ employee: id })
            .sort({ createdAt: -1 })
            .populate('employee', 'name employeeId avatar department');

          if (latestPastSession) {
            session = {
              _id: id,
              employee: latestPastSession.employee || empObj,
              totalDistance: Number(attRecord?.totalDistanceTraveled) || Number(latestPastSession.totalDistance) || 0,
              coordinates: latestPastSession.coordinates || [],
              startTime: latestPastSession.startTime,
              endTime: latestPastSession.endTime,
              isActive: latestPastSession.isActive,
              isCombined: true,
              isPastSession: true,
            };
          } else {
            session = {
              _id: id,
              employee: empObj || { name: 'Employee' },
              totalDistance: Number(attRecord?.totalDistanceTraveled) || 0,
              coordinates: [],
              isCombined: true,
            };
          }
        }
      }
    }
    if (!session) {
      session = await LiveLocation.findOne({ sessionId: id }).populate('employee', 'name employeeId avatar');
    }
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    // Optionally snap coordinates to road geometry using Google Roads API if requested
    if (req.query.snap === 'true' && Array.isArray(session.coordinates) && session.coordinates.length >= 2) {
      try {
        const snapped = await snapToRoads(session.coordinates, true);
        if (session.toObject) {
          session = session.toObject();
        }
        session.snappedCoordinates = snapped;
      } catch (_) {}
    }

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

    const scopedUsers = await User.find(userScope)
      .select('name employeeId department avatar isTracking isOnline lastSeen organizationId');
    const empIds = scopedUsers.map(e => e._id);

    // Active tracking sessions — strictly authoritative on isActive: true
    const locations = await LiveLocation.find({
      isActive: true,
      employee: { $in: empIds }
    }).populate('employee', 'name employeeId avatar department isOnline lastSeen');

    // Enrich active locations with real-time verified today trajectory distance
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const todayStartMs = new Date(`${today}T00:00:00.000Z`).getTime();

    // Auto-heal abandoned single-point sessions (where phone failed to start background tracking task)
    const activeLocations = [];
    const nowMs = Date.now();

    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const coordCount = loc.coordinates ? loc.coordinates.length : 0;
      const lastActMs = new Date(loc.lastActivity || loc.startTime || loc.createdAt || 0).getTime();

      // If a session has <= 1 coordinate and no background points for > 15 mins, auto-close it
      if (coordCount <= 1 && (nowMs - lastActMs) > 15 * 60 * 1000) {
        console.log(`🛡️ [AUTO_HEAL] Closing abandoned 1-point session for ${loc.employee?.name || loc.employee}`);
        LiveLocation.updateOne({ _id: loc._id }, { $set: { isActive: false, endTime: new Date() } }).catch(() => {});
        if (loc.employee?._id || loc.employee) {
          User.findByIdAndUpdate(loc.employee._id || loc.employee, { isTracking: false }).catch(() => {});
        }
        continue; // Exclude from active live locations list
      }
      activeLocations.push(loc);
    }

    for (let i = 0; i < activeLocations.length; i++) {
      const loc = activeLocations[i];
      let cleanKm = 0;

      // Primary: Authoritative DistanceLedger ACCEPTED sum
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: loc.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        cleanKm = Math.round(ledgerAgg[0].totalKm * 100) / 100;
      } else {
        const todayCoords = (loc.coordinates || []).filter(c => new Date(c.timestamp).getTime() >= todayStartMs);
        let todayCleanDistKm = 0;
        if (todayCoords.length >= 2) {
          let pPrev = null;
          for (const c of todayCoords) {
            const lat = Number(c.lat);
            const lng = Number(c.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) continue;
            if (c.mocked === true || c.isMock === true) continue;
            if (pPrev) {
              const dKm = haversineDistance({ lat: pPrev.lat, lng: pPrev.lng }, { lat, lng });
              const dt = Math.max((new Date(c.timestamp) - new Date(pPrev.timestamp)) / 1000, 0.5);
              const stepSpeed = (dKm / dt) * 3600;
              const speedKmh = Number(c.speed) > 0 ? (Number(c.speed) <= 60 ? Number(c.speed) * 3.6 : Number(c.speed)) : 0;
              
              if (dt <= 1800 && stepSpeed <= 180) {
                const isLowSpeed = speedKmh < 1.8 || stepSpeed < 1.8;
                const distM = dKm * 1000;
                if (!isLowSpeed || distM >= 50.0) {
                  todayCleanDistKm += dKm;
                  pPrev = c;
                }
              } else {
                pPrev = c;
              }
            } else {
              pPrev = c;
            }
          }
        }
        cleanKm = Math.round(todayCleanDistKm * 100) / 100;
      }
      
      const existingKm = Number(loc.totalDistance) || Number(loc.officialDistance) || 0;
      const finalKm = Math.round(Math.max(existingKm, cleanKm) * 100) / 100;
      loc.totalDistance = finalKm;
      loc.officialDistance = finalKm;
    }

    const activeEmpIdSet = new Set(activeLocations.map(l => String(l.employee?._id || l.employee)));

    // Auto-reconcile desynced User.isTracking flags
    const employees = [];
    scopedUsers.forEach(u => {
      const isActuallyTracking = activeEmpIdSet.has(String(u._id));
      if (u.isTracking !== isActuallyTracking) {
        User.findByIdAndUpdate(u._id, { isTracking: isActuallyTracking }).catch(() => {});
        u.isTracking = isActuallyTracking;
      }
      if (isActuallyTracking) {
        employees.push(u);
      }
    });

    res.json({ success: true, employees, locations: activeLocations });
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

// @desc Auto-recalculate session distance safely from validated TrackingPoints
// @desc Auto-recalculate session distance safely from validated TrackingPoints
const recalculateSessionFromPoints = async (sessionId) => {
  try {
    const session = await LiveLocation.findOne({ sessionId });
    if (!session) return 0;

    let points = await TrackingPoint.find({ 
      sessionId, 
      processingStatus: { $ne: 'REJECTED' } 
    }).sort({ timestamp: 1 }).lean();

    if (!points || points.length < 2) {
      points = (session.coordinates || []).filter(c => c && c.lat && c.lng);
    }
    if (!points || points.length < 2) return session.totalDistance || 0;

    // Sort chronologically
    points.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let totalDistKm = 0;
    const ledgerSegments = [];
    let prevPoint = null;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const lat = Number(pt.lat);
      const lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) continue;
      if (pt.mocked === true || pt.isMock === true) continue;

      if (prevPoint) {
        const dRawKm = haversineDistance(
          { lat: prevPoint.lat, lng: prevPoint.lng },
          { lat, lng }
        );

        const ts1 = new Date(prevPoint.timestamp).getTime();
        const ts2 = new Date(pt.timestamp).getTime();
        const dt = Math.max((ts2 - ts1) / 1000, 0.5);

        // Gap Re-Anchoring Policy: Time gaps > 30 minutes indicate offline/rest period. Re-anchor.
        if (dt > 1800) {
          prevPoint = pt;
          continue;
        }

        const distM = dRawKm * 1000;
        const stepSpeed = dt > 0 ? (dRawKm / dt) * 3600 : 0;
        const reportedSpeedKmh = Number(pt.speed) > 0 
          ? (Number(pt.speed) <= 60 ? Number(pt.speed) * 3.6 : Number(pt.speed))
          : 0;
        const effectiveSpeed = Math.max(stepSpeed, reportedSpeedKmh);

        // 1. Infeasible teleport (> 160 km/h) -> skip distance, advance anchor
        if (stepSpeed > 160 && dRawKm > 0.05) {
          prevPoint = pt;
          continue;
        }

        // 2. Stationary jitter gate: low speed & displacement < 40m -> skip distance, advance anchor
        if (effectiveSpeed < 2.0 && distM < 40.0) {
          prevPoint = pt;
          continue;
        }

        // 3. Genuine movement step
        if (distM >= 3.0 && stepSpeed <= 160) {
          totalDistKm += dRawKm;
          ledgerSegments.push({
            organizationId: session.organizationId,
            employee: session.employee,
            sessionId,
            fromEventId: prevPoint.eventId || `${sessionId}:${ts1}`,
            toEventId: pt.eventId || `${sessionId}:${ts2}`,
            fromTimestamp: new Date(ts1),
            toTimestamp: new Date(ts2),
            fromLat: prevPoint.lat,
            fromLng: prevPoint.lng,
            toLat: lat,
            toLng: lng,
            distanceMeters: Math.round(dRawKm * 1000),
            distanceKm: Math.round(dRawKm * 1000) / 1000,
            classification: 'ACCEPTED',
            reason: 'SAFE_RECALCULATED_VALIDATED_POINTS',
            algorithmVersion: 'AGTRIE-X-v10.0-CLEAN'
          });
          prevPoint = pt;
        } else {
          prevPoint = pt;
        }
      } else {
        prevPoint = pt;
      }
    }

    totalDistKm = Math.round(totalDistKm * 100) / 100;

    // Persist clean ledger and session totals
    await DistanceLedger.deleteMany({ sessionId });
    if (ledgerSegments.length > 0) {
      try {
        await DistanceLedger.insertMany(ledgerSegments, { ordered: false });
      } catch (insertErr) {
        console.error(`[recalculateSessionFromPoints] Ledger insert warning for ${sessionId}:`, insertErr.message);
      }
    }

    await LiveLocation.updateOne(
      { sessionId },
      { 
        $set: { 
          totalDistance: totalDistKm, 
          officialDistance: totalDistKm,
          acceptedDistance: totalDistKm,
          rawGpsDistance: totalDistKm
        } 
      }
    );

    const targetDate = session.date || new Date().toISOString().slice(0, 10);
    const allEmpSessions = await LiveLocation.find({ employee: session.employee, date: targetDate });
    const empDayTotal = allEmpSessions.reduce((sum, s) => sum + (s.sessionId === sessionId ? totalDistKm : (s.totalDistance || 0)), 0);

    await Attendance.updateOne(
      { employee: session.employee, date: targetDate },
      { $set: { totalDistanceTraveled: Math.round(empDayTotal * 100) / 100 } }
    ).catch(() => {});

    const currentState = (await getSessionState(sessionId)) || {};
    await saveSessionState(sessionId, {
      ...currentState,
      totalDistance: totalDistKm
    });

    return totalDistKm;
  } catch (err) {
    console.error(`[recalculateSessionFromPoints] Error for ${sessionId}:`, err.message);
    return 0;
  }
};
exports.recalculateSessionFromPoints = recalculateSessionFromPoints;

// @desc Continuous background worker to reconcile all active sessions in MongoDB (NON-DESTRUCTIVE SYNC)
exports.reconcileAllActiveSessions = async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const activeSessions = await LiveLocation.find({
      $or: [{ date: today }, { isActive: true }]
    });

    for (const session of activeSessions) {
      // Non-destructive audit: calculate official distance strictly from DistanceLedger ACCEPTED sum
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: session.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      const officialKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
      if (officialKm > 0 && Math.abs((session.totalDistance || 0) - officialKm) > 0.05) {
        await LiveLocation.updateOne(
          { sessionId: session.sessionId },
          { $set: { totalDistance: officialKm, officialDistance: officialKm, acceptedDistance: officialKm } }
        );
      }
    }
  } catch (err) {
    console.error('❌ [reconcileAllActiveSessions] Error:', err.message);
  }
};

// @desc Get live locations (optimized with server-side caching & tenant isolation)
exports.getLiveLocations = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;
    const cacheKey = `live_locations_${isSuperAdmin ? 'all' : orgId || req.user?._id}`;
    
    // Check cache (3s TTL)
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

    // Get active tracking sessions within last 14h cutoff (avoids timezone date dropping)
    const cutoff = new Date(Date.now() - 14 * 60 * 60 * 1000);
    const activeSessions = await LiveLocation.find({
      isActive: true,
      employee: { $in: empIds },
      $or: [
        { lastActivity: { $gte: cutoff } },
        { lastActivity: null, updatedAt: { $gte: cutoff } }
      ]
    }).populate('employee', 'name employeeId avatar department organizationId isOnline lastSeen');

    // Format for frontend
    const rawLocations = await Promise.all(activeSessions.map(async (session) => {
      if (!session.employee) return null;

      // Auto-recalculate 0.0 KM sessions if raw points exist
      if (!session.totalDistance || session.totalDistance === 0) {
        const recalculated = await recalculateSessionFromPoints(session.sessionId);
        if (recalculated > 0) session.totalDistance = recalculated;
      }

      const latestCoord = session.coordinates[session.coordinates.length - 1] || {};
      let displayDistance = 0;
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: session.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        displayDistance = Math.round(ledgerAgg[0].totalKm * 100) / 100;
      } else {
        const sessionState = await getSessionState(session.sessionId);
        const sessionDist = sessionState?.totalDistance ?? session.totalDistance ?? 0;
        displayDistance = Math.round(sessionDist * 100) / 100;
      }

      // Calculate today's full cumulative accepted KM across all today's sessions for this employee
      const today = getBusinessDate(new Date(), 'Asia/Kolkata');
      const todayStartMs = new Date(`${today}T00:00:00.000Z`).getTime();

      const empTodayLedgerAgg = await DistanceLedger.aggregate([
        {
          $match: {
            employee: session.employee._id,
            classification: 'ACCEPTED',
            toTimestamp: { $gte: new Date(todayStartMs) }
          }
        },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      let todayTotalKm = 0;
      if (empTodayLedgerAgg && empTodayLedgerAgg.length > 0 && typeof empTodayLedgerAgg[0].totalKm === 'number' && empTodayLedgerAgg[0].totalKm > 0) {
        todayTotalKm = Math.round(empTodayLedgerAgg[0].totalKm * 100) / 100;
      } else {
        todayTotalKm = displayDistance;
      }

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
        totalDistance: todayTotalKm,
        sessionTotalDistance: displayDistance,
        sessionId: session.sessionId,
        startTime: session.startTime,
        updatedAt: latestCoord.timestamp || session.updatedAt,
      };
    }));

    const locations = rawLocations.filter(Boolean);
    const responseData = { locations, count: locations.length };
    
    // Store in cache for 2 seconds for near-instant dashboard distance updates
    await liveCache.set(cacheKey, responseData, 2);

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
// @desc Delete all tracking history for an employee / Reset test data
exports.deleteEmployeeHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    const result = await LiveLocation.deleteMany({ employee: employeeId });
    await TrackingPoint.deleteMany({ employee: employeeId }).catch(() => {});
    await DistanceLedger.deleteMany({ employee: employeeId }).catch(() => {});
    await Attendance.deleteMany({ employee: employeeId }).catch(() => {});
    await User.findByIdAndUpdate(employeeId, { isTracking: false, isOnline: false }).catch(() => {});
    
    // Invalidate live location caches
    await deleteCache('live_locations_all').catch(() => {});

    // Log activity
    await ActivityLog.create({
      employee: req.user._id,
      action: 'HISTORY_DELETED',
      description: `Reset all tracking & attendance history for employee ${employeeId}`
    });

    res.json({ 
      success: true, 
      message: `Successfully reset all tracking & attendance history for employee.`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Reconcile session distance from DistanceLedger (Source of Truth)
exports.reconcileSession = async (req, res) => {
  try {
    const sessionId = req.params.id || req.body.sessionId;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId required' });

    // Aggregate from DistanceLedger
    const segments = await DistanceLedger.find({ sessionId }).lean();
    
    let acceptedKm = 0;
    let recoveredKm = 0;
    let rejectedKm = 0;
    let unverifiedKm = 0;

    segments.forEach((seg) => {
      const dist = Number(seg.distanceKm) || ((Number(seg.distanceMeters) || 0) / 1000);
      if (seg.classification === 'ACCEPTED') acceptedKm += dist;
      else if (seg.classification === 'RECOVERED') recoveredKm += dist;
      else if (seg.classification === 'REJECTED') rejectedKm += dist;
      else unverifiedKm += dist;
    });

    const officialKm = Math.round((acceptedKm + recoveredKm) * 1000) / 1000;
    const rawTotalKm = Math.round((acceptedKm + recoveredKm + rejectedKm + unverifiedKm) * 1000) / 1000;

    // Update LiveLocation with authoritative ledger sums
    const updated = await LiveLocation.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          totalDistance: officialKm,
          officialDistance: officialKm,
          acceptedDistance: Math.round(acceptedKm * 1000) / 1000,
          recoveredDistance: Math.round(recoveredKm * 1000) / 1000,
          rejectedDistance: Math.round(rejectedKm * 1000) / 1000,
          unverifiedDistance: Math.round(unverifiedKm * 1000) / 1000,
          rawGpsDistance: rawTotalKm
        }
      },
      { new: true }
    );

    // Sync Redis
    await saveSessionState(sessionId, {
      totalDistance: officialKm,
      lastTs: new Date().toISOString()
    });

    res.json({
      success: true,
      sessionId,
      officialKm,
      rawTotalKm,
      breakdown: {
        acceptedKm: Math.round(acceptedKm * 1000) / 1000,
        recoveredKm: Math.round(recoveredKm * 1000) / 1000,
        rejectedKm: Math.round(rejectedKm * 1000) / 1000,
        unverifiedKm: Math.round(unverifiedKm * 1000) / 1000,
      },
      session: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Diagnostic API — Deep Telemetry Inspection for Employee KM & Session Pipeline
exports.getSessionDiagnostic = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { employeeId } = req.query;

    const query = { date: today };
    if (employeeId) {
      query.employee = employeeId;
    }

    const activeSessions = await LiveLocation.find(query)
      .populate('employee', 'name employeeId department isOnline lastSeen')
      .sort({ createdAt: -1 });

    const diagnostics = await Promise.all(
      activeSessions.map(async (session) => {
        if (!session.employee) return null;

        // 1. Raw GPS Telemetry Count
        const rawPointCount = await TrackingPoint.countDocuments({ sessionId: session.sessionId });
        const lastRawPoint = await TrackingPoint.findOne({ sessionId: session.sessionId })
          .sort({ timestamp: -1 })
          .select('timestamp lat lng accuracy speed provider');

        // 2a. Raw polyline length + sampling-gap statistics (separates "points never arrived" from "engine lost km")
        const rawPts = await TrackingPoint.find({ sessionId: session.sessionId })
          .sort({ timestamp: 1 }).limit(8000).select('lat lng timestamp accuracy').lean();
        let rawPolylineKm = 0, maxGapSec = 0, gapsOver120s = 0, sumGapSec = 0;
        for (let i = 1; i < rawPts.length; i++) {
          const a = rawPts[i - 1], b = rawPts[i];
          const gap = (new Date(b.timestamp) - new Date(a.timestamp)) / 1000;
          if (gap > 0) { sumGapSec += gap; if (gap > maxGapSec) maxGapSec = gap; if (gap > 120) gapsOver120s++; }
          const seg = haversineDistance({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
          if (gap > 0 && (seg / gap) * 3600 <= 220) rawPolylineKm += seg;
        }
        rawPolylineKm = Math.round(rawPolylineKm * 100) / 100;
        const avgGapSec = rawPts.length > 1 ? Math.round(sumGapSec / (rawPts.length - 1)) : 0;
        const ledgerCount = await DistanceLedger.countDocuments({ sessionId: session.sessionId });
        const ledgerAgg = await DistanceLedger.aggregate([
          { $match: { sessionId: session.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
          { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
        ]);
        const ledgerTotalKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;

        // 3. Cache State
        const sessionState = await getSessionState(session.sessionId);

        // 4. Determine Exact Diagnostic Bottleneck
        let diagnosticStatus = 'OK_ACTIVE_CALCULATED';
        let actionRequired = 'None. Tracking pipeline operating normally.';

        if (rawPointCount === 0) {
          diagnosticStatus = 'NO_MOBILE_GPS_RECEIVED';
          actionRequired = 'Employee phone is not sending GPS pings. Check Location Permission ("Allow all the time"), Battery Optimization, and verify app is running.';
        } else if (rawPointCount > 0 && ledgerTotalKm === 0) {
          if (rawPolylineKm > 0.1) {
            diagnosticStatus = 'PROCESSING_OR_GAP_ISSUE';
            actionRequired = `Raw GPS points show ${rawPolylineKm} km movement, but distance ledger total is 0. Check for long gaps, processing errors, or run session reconcile.`;
          } else {
            diagnosticStatus = 'GPS_RECEIVED_STATIONARY_RESTING';
            actionRequired = 'GPS fixes are arriving, but employee is stationary / resting (speed = 0 km/h). Distance will count once movement starts.';
          }
        } else if (ledgerTotalKm > 0 && (session.totalDistance || 0) === 0) {
          diagnosticStatus = 'LEDGER_AGGREGATION_DISCREPANCY';
          actionRequired = 'Ledger has calculated distance, but LiveLocation total is un-synced. Run session reconcile.';
        } else if (rawPolylineKm > 0.5 && ledgerTotalKm < rawPolylineKm * 0.9) {
          diagnosticStatus = 'ENGINE_LOSS_RAW_POLYLINE_HIGHER';
          actionRequired = `Stored GPS points sum to ${rawPolylineKm} km but ledger has ${ledgerTotalKm} km. Engine is dropping valid movement - send this JSON for tuning.`;
        } else if (gapsOver120s > 3 || avgGapSec > 60) {
          diagnosticStatus = 'SPARSE_GPS_SAMPLING';
          actionRequired = `Phone delivered few GPS fixes (avg gap ${avgGapSec}s, max gap ${maxGapSec}s, ${gapsOver120s} gaps >2min). Km lost on road curves between fixes. Fix on phone: Location "Allow all the time", Battery "Unrestricted", disable OEM app-killer.`;
        }

        return {
          employeeName: session.employee.name,
          employeeIdCode: session.employee.employeeId,
          employeeId: session.employee._id,
          sessionId: session.sessionId,
          isActive: session.isActive,
          startTime: session.startTime,
          lastActivity: session.lastActivity,
          diagnosticStatus,
          actionRequired,
          telemetry: {
            rawPointCount,
            rawPolylineKm,
            avgGapSec,
            maxGapSec,
            gapsOver120s,
            lastRawPointTimestamp: lastRawPoint?.timestamp || null,
            lastRawPointCoordinates: lastRawPoint ? `${lastRawPoint.lat}, ${lastRawPoint.lng}` : null,
            lastAccuracyMeters: lastRawPoint?.accuracy || 0,
            lastSpeedMps: lastRawPoint?.speed || 0,
            ledgerSegmentCount: ledgerCount,
            ledgerTotalKm,
            liveLocationSessionKm: session.totalDistance || 0,
            redisCachedKm: sessionState?.totalDistance || 0,
          }
        };
      })
    );

    res.json({
      success: true,
      diagnosticsCount: diagnostics.filter(Boolean).length,
      diagnostics: diagnostics.filter(Boolean)
    });
  } catch (err) {
    console.error('❌ [DIAGNOSTIC_ERROR]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
