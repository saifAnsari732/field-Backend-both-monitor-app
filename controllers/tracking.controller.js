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

// In-memory throttle for closed session drop logs (max 1 log per 60s per session)
const closedSessionLogThrottle = new Map();

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

    // Check if employee already has a session today (or a stale active session from a previous day)
    const existingActiveSession = await LiveLocation.findOne({
      employee: req.user._id,
      $or: [{ isActive: true }, { date: today }]
    }).sort({ isActive: -1, totalDistance: -1, createdAt: -1 });

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
        console.log(`📍 startTracking: Resuming/re-attaching to today's session ${existingActiveSession.sessionId} (${existingActiveSession.totalDistance || 0} km)`);
        const updateFields = {
          isActive: true,
          autoClosed: false,
          lastActivity: new Date(),
        };
        if (selfieUrl) updateFields.selfieUrl = selfieUrl;
        const resumedSession = await LiveLocation.findByIdAndUpdate(
          existingActiveSession._id,
          { $set: updateFields, $unset: { endTime: 1 } },
          { new: true }
        );
        const existingState = await getSessionState(existingActiveSession.sessionId);
        const lastC = (resumedSession?.coordinates && resumedSession.coordinates[resumedSession.coordinates.length - 1]) || null;
        await saveSessionState(existingActiveSession.sessionId, {
          ...(existingState || {}),
          totalDistance: Math.max(Number(resumedSession?.totalDistance) || 0, Number(existingState?.totalDistance) || 0),
          date: today,
          lastLat: existingState?.lastLat || (lastC ? Number(lastC.lat) : (hasCoords ? lat : null)),
          lastLng: existingState?.lastLng || (lastC ? Number(lastC.lng) : (hasCoords ? lng : null)),
          lastTs: existingState?.lastTs || (lastC?.timestamp ? new Date(lastC.timestamp).toISOString() : new Date().toISOString()),
        }).catch(() => {});
        await User.findByIdAndUpdate(req.user._id, { isTracking: true, isOnline: true, lastSeen: new Date() });
        await Attendance.findOneAndUpdate(
          { employee: req.user._id, date: today },
          { $unset: { checkOut: 1 } }
        ).catch(() => {});
        return res.status(200).json({
          success: true,
          message: 'Active shift resumed.',
          sessionId: existingActiveSession.sessionId,
          totalDistance: resumedSession?.totalDistance || 0,
          totalDistanceToday: resumedSession?.totalDistance || 0,
          startTime: resumedSession?.startTime || existingActiveSession.startTime,
          session: resumedSession || existingActiveSession,
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
      sessionId: session.sessionId,
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
  if (speedKmh < 3) return 'STATIONARY';
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
  const today = getBusinessDate(new Date(), 'Asia/Kolkata');
  await Attendance.findOneAndUpdate({ employee: employeeId, date: today }, { $unset: { checkOut: 1 } }).catch(() => {});
  console.log(`[tracking] Auto-reactivated session ${sessionId} for employee ${employeeId}`);
  return true;
}

// @desc Update location (bulk coordinates) — AGTRIE-X v12 State-Space Pipeline
exports.updateLocation = async (req, res) => {
  let releaseSessionLock;
  try {
    let { sessionId, coordinates } = req.body;
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      return res.status(400).json({ success: false, message: 'coordinates array is required' });
    }

    const orgId = req.user.organizationId?._id || req.user.organizationId;
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');

    // ─── SELF-HEALING TOKEN-BASED SESSION RESOLUTION ──────────────────────────
    // If mobile app lost currentTrackingSessionId in AsyncStorage (or sent AUTO_RECOVER_SESSION),
    // automatically resolve or create today's LiveLocation session from the authenticated JWT user!
    if (!sessionId || sessionId === 'AUTO_RECOVER_SESSION') {
      let recoveredDoc = await LiveLocation.findOne(
        { employee: req.user._id, date: today },
        { sessionId: 1, isActive: 1 }
      ).sort({ isActive: -1, createdAt: -1 });

      if (!recoveredDoc) {
        const freshSessionId = uuidv4();
        recoveredDoc = await LiveLocation.create({
          organizationId: orgId,
          employee: req.user._id,
          sessionId: freshSessionId,
          coordinates: [],
          isActive: true,
          date: today,
          startTime: new Date(),
          startAddress: req.body?.currentAddress || 'Auto-Recovered Live Shift'
        });
      }
      sessionId = recoveredDoc.sessionId;
    }

    // Normalize any AUTO_RECOVER_SESSION prefix inside coordinate eventIds
    coordinates = coordinates.map((c) => {
      if (c && typeof c.eventId === 'string' && c.eventId.startsWith('AUTO_RECOVER_SESSION:')) {
        return { ...c, eventId: c.eventId.replace('AUTO_RECOVER_SESSION:', `${sessionId}:`) };
      }
      return c;
    });

    // Acquire per-session lock FIRST so dual-engine (Screen + Background) requests never collide on bulkWrite or state!
    releaseSessionLock = await acquireDistributedLock(sessionId, 8000, 6000);

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
              algorithmVersion: 'AGTRIE-X-v12.0-PRO',
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
        const isDupKey = rawStoreErr.code === 11000 || rawStoreErr.name === 'MongoBulkWriteError' || String(rawStoreErr.message || '').includes('E11000');
        if (!isDupKey) {
          console.error('❌ [RAW_GPS_STORE_ERROR] Failed to persist raw GPS telemetry:', rawStoreErr.message);
          if (releaseSessionLock) await releaseSessionLock().catch(() => {});
          return res.status(500).json({ 
            success: false, 
            message: 'Raw GPS persistence failed. Request will be retried by mobile offline queue.',
            retryable: true 
          });
        }
      }
    }

    // Verify session in MongoDB (lightweight projection without pulling 500 coordinates into RAM on every tick!)
    let activeDoc = await LiveLocation.findOne(
      { sessionId, employee: req.user._id },
      { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
    );
    
    // Multi-Day Zombie Session Auto-Close Guard:
    // If activeDoc belongs to a previous date, auto-close yesterday's shift and tell mobile app to stop!
    if (activeDoc && activeDoc.date && activeDoc.date !== today) {
      if (activeDoc.isActive) {
        activeDoc.isActive = false;
        activeDoc.autoClosed = true;
        activeDoc.endTime = activeDoc.lastActivity || new Date(`${activeDoc.date}T23:59:59.999Z`);
        await activeDoc.save();
        console.log(`🛡️ [DATE_ROLLOVER] Auto-closed yesterday session ${sessionId} from ${activeDoc.date} for employee ${req.user._id}`);
      }
      if (releaseSessionLock) await releaseSessionLock().catch(() => {});
      return res.json({
        success: true,
        sessionClosed: true,
        message: `Shift from ${activeDoc.date} has ended. Please punch in for today.`,
        totalDistance: activeDoc.totalDistance || 0
      });
    }

    if (!activeDoc) {
      activeDoc = await LiveLocation.findOne(
        { employee: req.user._id, isActive: true, date: today },
        { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
      ).sort({ createdAt: -1 });
      if (!activeDoc) {
        const freshSessionId = uuidv4();
        sessionId = freshSessionId;
        activeDoc = await LiveLocation.create({
          organizationId: orgId,
          employee: req.user._id,
          sessionId: freshSessionId,
          coordinates: [],
          isActive: true,
          date: today,
          startTime: new Date(),
          startAddress: 'Auto-Adopted Live Shift'
        });
      } else {
        sessionId = activeDoc.sessionId;
      }
    }

    if (!activeDoc.isActive) {
      // If employee already has a newer active session today (e.g. re-punched in), transparently switch to it!
      const newerActiveDoc = await LiveLocation.findOne(
        { employee: req.user._id, isActive: true, date: today, _id: { $ne: activeDoc._id } },
        { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
      ).sort({ createdAt: -1 });

      if (newerActiveDoc) {
        activeDoc = newerActiveDoc;
        sessionId = newerActiveDoc.sessionId;
      } else {
        const msSinceEnd = activeDoc.endTime ? (Date.now() - new Date(activeDoc.endTime).getTime()) : 999999;
        const wasExplicitManualStop = !activeDoc.autoClosed && msSinceEnd < 20000 &&
          await ActivityLog.exists({ action: 'TRACKING_STOP', 'metadata.sessionId': sessionId });

        if (wasExplicitManualStop) {
          const lastLog = closedSessionLogThrottle.get(sessionId) || 0;
          if (Date.now() - lastLog > 60000) {
            closedSessionLogThrottle.set(sessionId, Date.now());
            console.log(`🛑 [SESSION_CLOSED] Received trailing GPS telemetry within 20s of manual Punch Out for ${sessionId}.`);
          }
          if (releaseSessionLock) await releaseSessionLock().catch(() => {});
          return res.json({ 
            success: true, 
            message: 'Session already ended by employee.', 
            sessionClosed: true, 
            totalDistance: activeDoc.totalDistance || 0 
          });
        }
        activeDoc.isActive = true;
        activeDoc.autoClosed = false;
        activeDoc.endTime = undefined;
        activeDoc.lastActivity = new Date();
        await LiveLocation.updateOne(
          { _id: activeDoc._id },
          { $set: { isActive: true, autoClosed: false, lastActivity: new Date() }, $unset: { endTime: 1 } }
        ).catch(() => {});
        await User.findByIdAndUpdate(req.user._id, { isTracking: true }).catch(() => {});
        console.log(`🛡️ [AUTO_RESUME] Auto-reactivated today's session ${sessionId} and captured coordinates for ${req.user.name || req.user._id}`);
      }
    }

    let sessionState = await getSessionState(sessionId);
    if (!sessionState) {
      const lastCoordDb = (activeDoc.coordinates && activeDoc.coordinates[activeDoc.coordinates.length - 1]) || {};
      sessionState = {
        totalDistance: activeDoc.totalDistance || 0,
        manualDistanceAdded: activeDoc.manualDistanceAdded || 0,
        date: activeDoc.date,
        lastLat: lastCoordDb.lat || 0,
        lastLng: lastCoordDb.lng || 0,
        lastTs: lastCoordDb.timestamp || new Date().toISOString(),
        lastEventId: lastCoordDb.eventId || null,
        kfState: null,
        lastVx: 0,
        lastVy: 0,
        lastSpeed: 0,
      };

      // On cache miss only: check if DistanceLedger has a newer committed anchor than lastCoordDb
      const latestLedger = await DistanceLedger.findOne({ sessionId }).sort({ toTimestamp: -1 }).select('toTimestamp toLat toLng toEventId').lean();
      if (latestLedger && latestLedger.toTimestamp) {
        const ledgerTs = new Date(latestLedger.toTimestamp).getTime();
        const currentTs = sessionState.lastTs ? new Date(sessionState.lastTs).getTime() : 0;
        // CRITICAL FIX: Only overwrite sessionState anchor if latestLedger is strictly newer (ledgerTs >= currentTs)!
        // Previously, overwriting lastLat/lastLng when ledgerTs < currentTs snapped the anchor back to an hours-old
        // coordinate while keeping the recent timestamp, causing all future points to fail > 180 km/h teleportation!
        if (ledgerTs >= currentTs && Number.isFinite(latestLedger.toLat) && Number.isFinite(latestLedger.toLng)) {
          sessionState.lastLat = latestLedger.toLat;
          sessionState.lastLng = latestLedger.toLng;
          sessionState.lastEventId = latestLedger.toEventId;
          sessionState.lastTs = new Date(latestLedger.toTimestamp).toISOString();
        }
      }
      await saveSessionState(sessionId, sessionState);
    }

    // Step 1: Chronological Sorting & Durable Idempotency Gate
    const orderedCoordinates = [...coordinates].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Durable Idempotency Gate (drops duplicate retries if already processed by Screen or Background engine)
    const incomingEventIds = [];
    const nonDuplicateCoordinates = [];
    for (const c of orderedCoordinates) {
      if (c?.eventId) {
        const isNewInRedis = await checkAndSetIdempotency(sessionId, c.eventId);
        if (!isNewInRedis) {
          // Verify if this event was already processed in TrackingPoint or committed into DistanceLedger
          const alreadyProcessed =
            (await TrackingPoint.exists({ sessionId, eventId: c.eventId, processingStatus: { $in: ['ACCEPTED', 'REJECTED'] } })) ||
            (await DistanceLedger.exists({ sessionId, toEventId: c.eventId }));
          if (alreadyProcessed) continue; // Safely skip already-processed point from dual-engine relay
        }
        incomingEventIds.push(c.eventId);
      }
      nonDuplicateCoordinates.push(c);
    }

    if (nonDuplicateCoordinates.length === 0) {
      if (typeof releaseSessionLock === 'function') await releaseSessionLock();
      return res.json({ success: true, totalDistance: sessionState.totalDistance || 0, duplicate: true });
    }

    const existingEventIdSet = new Set();

    // Initialize Geodetic 2D Kalman Filter state from sessionState
    let filterLat = Number(sessionState.lastLat) || Number(nonDuplicateCoordinates[0]?.lat) || 0;
    let filterLng = Number(sessionState.lastLng) || Number(nonDuplicateCoordinates[0]?.lng) || 0;
    let filterPLat = Number(sessionState.pLat) || 0.00000001;
    let filterPLng = Number(sessionState.pLng) || 0.00000001;

    // Centroid Micro-Geofence anchor for AGTRIE-X v7
    let centroidLat = Number(sessionState.centroidLat) || filterLat;
    let centroidLng = Number(sessionState.centroidLng) || filterLng;

    // Reconcile any Admin Manual Adjustment from activeDoc (already loaded above — zero extra DB query!)
    const dbLiveDoc = activeDoc;
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
    let lastTickMs = sessionState.lastTickTs ? new Date(sessionState.lastTickTs).getTime() : prevTimestamp;
    let lastValidLat = filterLat;
    let lastValidLng = filterLng;
    let lastEventId = sessionState.lastEventId || null;
    let relockCandidate = sessionState.relockCandidate || null;

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
    let prevValid = {
      lat: lastValidLat,
      lng: lastValidLng,
      latRaw: lastValidLat,
      lngRaw: lastValidLng,
      speedKmh: Number(sessionState.lastSpeed) || 0,
      candidateDistM: Number(sessionState.candidateDistM) || 0,
      timestamp: new Date(prevTimestamp || Date.now()).toISOString(),
      heading: null
    };

    // Forward Geodetic Bayesian Kinematic Filtering Pass (AGTRIE-X 7.0)
    for (let i = 0; i < nonDuplicateCoordinates.length; i++) {
      const coord = nonDuplicateCoordinates[i];
      const lat = Number(coord?.lat);
      const lng = Number(coord?.lng);
      let timestamp = new Date(coord?.timestamp);
      let tMs = timestamp.getTime();
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
      if (prevTimestamp && tMs <= prevTimestamp) {
        // CRITICAL FIX: Phone GPS clock can be 2s to 3min behind server clock (e.g. startTime = new Date()).
        // Only skip if it is an exact duplicate position within 3 seconds; otherwise clamp tMs forward so valid coordinates are NEVER dropped!
        const samePos = Number.isFinite(lastValidLat) && Number.isFinite(lastValidLng) &&
          Math.abs(lat - lastValidLat) < 0.00001 && Math.abs(lng - lastValidLng) < 0.00001;
        if (samePos && (prevTimestamp - tMs) < 3000) {
          continue;
        }
        tMs = prevTimestamp + 1000;
        timestamp = new Date(tMs);
      }

      const accuracy = Number(coord.accuracy) || 30;
      sumAccuracy += accuracy;
      if (accuracy > batchWorstAccuracy) batchWorstAccuracy = accuracy;

      // Ensure dt is calculated against last trusted anchor, while stepDt tracks the latest GPS tick interval
      const lastTrustedMs = prevValid?.timestamp ? new Date(prevValid.timestamp).getTime() : (prevTimestamp || tMs - 1000);
      const dt = Math.max((tMs - lastTrustedMs) / 1000, 0.5);
      const stepDt = Math.max((tMs - (lastTickMs || lastTrustedMs)) / 1000, 0.5);
      lastTickMs = tMs;

      // 3. Master Bayesian GPS Scoring (AGTRIE-X 7.0)
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
        // ── 30-MINUTE / 4-5 HOUR STATIONARY RE-ANCHORING & GAP RECOVERY ──────
        // Check if genuine travel occurred after a long stationary stop (e.g. 4-5 hours at home/client)
        // OR during a device sleep gap while travelling.
        const dGapKm = prevValid
          ? haversineDistance(
              { lat: prevValid.latRaw ?? prevValid.lat, lng: prevValid.lngRaw ?? prevValid.lng },
              { lat, lng }
            )
          : 0;
        const gapSpeedKmh = dGapKm > 0 ? (dGapKm / (dt / 3600)) : 0;
        const toKmh = (s) => (Number(s) > 0 ? (Number(s) <= 60 ? Number(s) * 3.6 : Number(s)) : 0);
        const reportedSpeedKmh = toKmh(coord.speed);

        // CRITICAL FIX:
        // 1. Fresh Departure After Long Stop (25m to 2.5km): When an employee sits stationary for 4-5 hours,
        //    no coordinates are uploaded during the stop (only heartbeats). When they start moving, their first
        //    uploaded coordinate is 25m-500m from the stationary anchor, so dividing by 4.5 hours (dt=16200s)
        //    previously gave gapSpeedKmh = 0.01 km/h (< 1.5 km/h) and rejected the movement!
        // 2. Long Gap Travel Recovery (> 0.15km): Phone slept while employee traveled across town.
        const isStationaryDeparture = dGapKm >= 0.020 && dGapKm <= 3.5 && accuracy <= 300;
        const isGapTravelRecovery = dGapKm >= 0.050 && gapSpeedKmh <= 160.0 && accuracy <= 300;

        if (isStationaryDeparture || isGapTravelRecovery) {
          acceptedPoints++;
          acceptedEventIds.push(eventId);
          prevTimestamp = tMs;

          // Apply 1.12x road curvature compensation for long sleep/offline gaps (>= 300m) so straight-line chords never lose curve KM
          const effectiveGapKm = dGapKm >= 0.300 ? Math.round(dGapKm * 1.12 * 1000) / 1000 : dGapKm;

          const effectiveResumeSpeed = Math.max(reportedSpeedKmh, gapSpeedKmh, 5.0);
          if (effectiveResumeSpeed > batchMaxSpeed && effectiveResumeSpeed <= 160) {
            batchMaxSpeed = effectiveResumeSpeed;
          }

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
            distanceMeters: Math.round(effectiveGapKm * 1000),
            distanceKm: Math.round(effectiveGapKm * 1000) / 1000,
            classification: 'ACCEPTED',
            reason: isStationaryDeparture ? 'AGTRIE_X_STATIONARY_DEPARTURE_ACCEPTED' : 'AGTRIE_X_GAP_TRAVEL_RECOVERED',
            algorithmVersion: 'AGTRIE-X-v12.0-PRO'
          });

          ActivityLog.create({
            employee: req.user._id,
            action: 'TRAVEL_RESUMED',
            description: `Travel resumed after ${(dt / 60).toFixed(0)} min stationary stop (+${effectiveGapKm.toFixed(2)} km).`,
            metadata: { sessionId, distanceKm: effectiveGapKm, gapMinutes: Math.round(dt / 60) }
          }).catch(() => {});

          console.log(`📍 [STATIONARY_WAKEUP] Accepted +${effectiveGapKm.toFixed(3)} km after ${(dt / 60).toFixed(0)} min stationary gap (speed: ${effectiveResumeSpeed.toFixed(1)} km/h)`);
        }

        // Reset filter directly on fresh observation to eliminate covariance lag.
        filterLat = lat;
        filterLng = lng;
        filterPLat = R;
        filterPLng = R;
        lastValidLat = lat;
        lastValidLng = lng;
        lastEventId = eventId;
        prevTimestamp = tMs;
        relockCandidate = null;

        centroidLat = lat;
        centroidLng = lng;

        prev2Valid = prevValid;
        prevValid = {
          lat: filterLat,
          lng: filterLng,
          latRaw: lat,
          lngRaw: lng,
          accuracy,
          speedKmh: Math.max(reportedSpeedKmh, gapSpeedKmh, isStationaryDeparture ? 5.0 : 0),
          candidateDistM: 0,
          timestamp: timestamp.toISOString(),
          heading: coord.heading
        };

        // CRITICAL FIX: Always push the post-gap coordinate to validCoords so LiveLocation.coordinates
        // in MongoDB and the Admin Live Map are immediately updated when the employee starts moving!
        validCoords.push({
          ...coord,
          eventId,
          lat: filterLat,
          lng: filterLng,
          timestamp: timestamp.toISOString()
        });

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

      // 5. Raw Segment Distance & Kinematic Calculations (strictly from last committed anchor)
      const anchorLat = prevValid?.latRaw ?? lastValidLat;
      const anchorLng = prevValid?.lngRaw ?? lastValidLng;
      const dRawKm = haversineDistance(
        { lat: anchorLat, lng: anchorLng },
        { lat, lng }
      );
      const distM = dRawKm * 1000;

      const toKmh = (s) => (Number(s) > 0 ? (Number(s) <= 60 ? Number(s) * 3.6 : Number(s)) : 0);
      const reportedSpeedKmh = toKmh(coord.speed);
      const rawCalcSpeedKmh = dt > 0 ? (dRawKm / dt) * 3600 : 0;
      const prevWasMoving = (Number(prevValid?.speedKmh) || 0) >= 3.0;
      const stepWindowSecs = Math.min(dt, Math.max(stepDt, 4.0), 20.0);
      const stepCalcSpeedKmh = (!prevWasMoving && distM >= 12.0 && stepWindowSecs > 0)
        ? Math.min((dRawKm / stepWindowSecs) * 3600, 65.0)
        : 0;
      const effectiveSpeedKmh = Math.max(reportedSpeedKmh, rawCalcSpeedKmh, stepCalcSpeedKmh);

      if (effectiveSpeedKmh > batchMaxSpeed && effectiveSpeedKmh <= 160) {
        batchMaxSpeed = effectiveSpeedKmh;
      }

      // 🛑 STRICT IDENTICAL COORDINATE / ZERO-DISPLACEMENT GUARD:
      // Agar client se identical ya near-identical coordinate mil rahe hain (< 1.2m delta ya dRawKm == 0):
      // 1. Distance bilkul 0 KM add hogi (no fake jitter or duplicate coordinate accumulation)
      // 2. Centroid update nahi hoga
      // 3. Keepalive timestamp update hoga taki session disconnected na ho
      const isIdenticalToAnchor = distM < 1.2 || (
        Math.abs(lat - anchorLat) < 0.000010 &&
        Math.abs(lng - anchorLng) < 0.000010
      );

      if (isIdenticalToAnchor && effectiveSpeedKmh < 1.8) {
        // Coordinate is the same: Employee is stopped at the spot. Zero KM added.
        lastValidTimestamp = Math.max(lastValidTimestamp, tMs);
        continue;
      }

      // 6. High-Fidelity Movement vs Stationary Centroid Geofence Gate (AGTRIE-X v12.0)
      const distFromCentroidM = haversineDistance({ lat: centroidLat, lng: centroidLng }, { lat, lng }) * 1000;
      const isCoarseJump = accuracy > ((effectiveSpeedKmh >= 3.2 && distM >= 22.0) || coord.screenMoving === true ? 300 : 240);
      const centroidGeofenceRadiusM = coord.screenMoving === true ? 6.0 : Math.max(25.0, Math.min(40.0, accuracy * 0.85));
      const hasDopplerTravel = (reportedSpeedKmh >= 3.5 && distFromCentroidM >= 20.0 && accuracy <= 220) ||
        (effectiveSpeedKmh >= 4.0 && distFromCentroidM >= 30.0 && accuracy <= 260) ||
        (coord.screenMoving === true && (distFromCentroidM >= 6.0 || effectiveSpeedKmh >= 1.5) && accuracy <= 300);

      // Single-spike indoor multipath guard (ONLY when transitioning out of STATIONARY state):
      let isUnconfirmedSingleSpike = false;
      if (!prevWasMoving && !hasDopplerTravel && reportedSpeedKmh < 3.0 && distFromCentroidM < 42.0) {
        if (coord.screenMoving === true && distFromCentroidM >= 6.0) {
          isUnconfirmedSingleSpike = false;
        } else if (prevValid?.candidateDistM && distFromCentroidM >= prevValid.candidateDistM + 7 && distFromCentroidM >= 25.0) {
          // Second consecutive point progressed at least 7m further from first candidate -> confirmed departure!
          isUnconfirmedSingleSpike = false;
        } else {
          isUnconfirmedSingleSpike = true;
        }
      }

      // CRITICAL FIX:
      // - When STATIONARY (!prevWasMoving), apply the 6-40m centroid geofence bubble + 2-point spike guard.
      // - When ALREADY MOVING (prevWasMoving === true), never block active road movement with the stationary bubble!
      // - When prevWasMoving === true and a traffic/corner pause (< 180s / 3 min) has distM < 8.0m, hold the anchor AND preserve
      //   prevWasMoving (speedKmh) + prevTimestamp so brief stops NEVER reset movement to STATIONARY or break the route!
      const isInsideCentroidGeofence = !prevWasMoving && !hasDopplerTravel && distFromCentroidM < centroidGeofenceRadiusM && effectiveSpeedKmh < 3.6;
      const isMicroStep = distM < (coord.screenMoving ? 2.5 : 5.0);
      const isSlowStopStep = prevWasMoving ? (distM < 5.0 && effectiveSpeedKmh < 1.4) : (distM < 8.0 && effectiveSpeedKmh < 1.4 && !hasDopplerTravel);
      const isStationaryDrift = !isCoarseJump && (isInsideCentroidGeofence || isUnconfirmedSingleSpike || isMicroStep || isSlowStopStep);
      const isTeleportation = effectiveSpeedKmh > 180.0 || isCoarseJump;
      const isMathematicallyValidMovement = !isStationaryDrift && !isTeleportation && dRawKm > 0;

      if (isMathematicallyValidMovement) {
        acceptedPoints++;
        acceptedEventIds.push(eventId);
        prevTimestamp = tMs;
        relockCandidate = null;

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
          fromLat: anchorLat,
          fromLng: anchorLng,
          toLat: lat,
          toLng: lng,
          distanceMeters: Math.round(dRawKm * 1000),
          distanceKm: Math.round(dRawKm * 1000) / 1000,
          classification: 'ACCEPTED',
          reason: 'AGTRIE_X_V12_CENTROID_GEODESIC_ACCEPTED',
          algorithmVersion: 'AGTRIE-X-v12.0-PRO'
        });

        centroidLat = lat;
        centroidLng = lng;
        prev2Valid = prevValid;
        lastValidLat = lat;
        lastValidLng = lng;
        lastEventId = eventId;
        prevValid = {
          lat: filterLat,
          lng: filterLng,
          latRaw: lat,
          lngRaw: lng,
          accuracy,
          speedKmh: Math.max(reportedSpeedKmh, rawCalcSpeedKmh, 4.0),
          candidateDistM: 0,
          timestamp: timestamp.toISOString(),
          heading: coord.heading
        };
      } else if (isStationaryDrift) {
        if (prevWasMoving && dt < 180) {
          // Brief traffic stop or sub-8m tick while actively moving (< 180s / 3 min since last accepted coordinate):
          // Hold lastValidLat/Lng, lastTrustedMs, and prevValid.speedKmh intact so the next road step accumulates with ZERO route break!
          acceptedEventIds.push(eventId);
        } else {
          // Softly converge centroid via exponential moving average, but DO NOT move the committed distance anchor
          centroidLat = centroidLat * 0.98 + lat * 0.02;
          centroidLng = centroidLng * 0.98 + lng * 0.02;
          filterLat = snap.lat;
          filterLng = snap.lng;
          filterPLat = snap.pLat;
          filterPLng = snap.pLng;
          prevTimestamp = tMs;
          // Preserve the FIRST candidateDistM (>= 16m) instead of overwriting it with larger intermediate values
          const existingCandM = Number(prevValid?.candidateDistM) || 0;
          const nextCandM = distFromCentroidM >= 16.0
            ? (existingCandM > 0 ? Math.min(existingCandM, distFromCentroidM) : distFromCentroidM)
            : 0;
          prevValid = {
            ...prevValid,
            latRaw: anchorLat,
            lngRaw: anchorLng,
            speedKmh: 0,
            candidateDistM: nextCandM,
            timestamp: prevValid?.timestamp || timestamp.toISOString()
          };
          acceptedEventIds.push(eventId);
        }
      } else {
        // 2-Point Satellite/Network Consensus Relock (supports up to 240m accuracy):
        if (!isCoarseJump && accuracy <= 240 && relockCandidate && tMs > relockCandidate.tMs && (tMs - relockCandidate.tMs) <= 120000) {
          const dRelockKm = haversineDistance({ lat: relockCandidate.lat, lng: relockCandidate.lng }, { lat, lng });
          const dtRelockS = Math.max((tMs - relockCandidate.tMs) / 1000, 1);
          const relockSpeedKmh = (dRelockKm / dtRelockS) * 3600;
          if (dRelockKm <= 1.5 && relockSpeedKmh <= 140.0) {
            console.log(`🛡️ [SATELLITE_RELOCK] Re-anchoring session ${sessionId} to verified consensus (${(dRelockKm * 1000).toFixed(0)}m step at ${relockSpeedKmh.toFixed(1)} km/h)`);
            filterLat = lat;
            filterLng = lng;
            filterPLat = R;
            filterPLng = R;
            lastValidLat = lat;
            lastValidLng = lng;
            centroidLat = lat;
            centroidLng = lng;
            lastEventId = eventId;
            prevTimestamp = tMs;
            if (dRelockKm >= 0.010) {
              acceptedPoints++;
              ledgerSegments.push({
                organizationId: orgId,
                employee: req.user._id,
                sessionId,
                fromEventId: relockCandidate.eventId || lastEventId || `${sessionId}:relock`,
                toEventId: eventId,
                fromTimestamp: new Date(relockCandidate.tMs),
                toTimestamp: timestamp,
                fromLat: relockCandidate.lat,
                fromLng: relockCandidate.lng,
                toLat: lat,
                toLng: lng,
                distanceMeters: Math.round(dRelockKm * 1000),
                distanceKm: Math.round(dRelockKm * 1000) / 1000,
                classification: 'ACCEPTED',
                reason: 'AGTRIE_X_SATELLITE_CONSENSUS_RELOCK',
                algorithmVersion: 'AGTRIE-X-v12.0-PRO'
              });
            }
            prevValid = {
              lat: filterLat,
              lng: filterLng,
              latRaw: lat,
              lngRaw: lng,
              accuracy,
              speedKmh: Math.max(reportedSpeedKmh, relockSpeedKmh, 4.0),
              candidateDistM: 0,
              timestamp: timestamp.toISOString(),
              heading: coord.heading
            };
            relockCandidate = null;
            validCoords.push({
              ...coord,
              eventId,
              lat: filterLat,
              lng: filterLng,
              timestamp: timestamp.toISOString()
            });
            acceptedEventIds.push(eventId);
            continue;
          }
        }

        if (!isCoarseJump && accuracy <= 240) {
          relockCandidate = { lat, lng, tMs, accuracy, eventId };
        }

        // GPS outlier / teleportation > 180 km/h or coarse accuracy > 300m:
        // Restore Kalman snapshot completely so the outlier NEVER contaminates the anchor!
        filterLat = snap.lat;
        filterLng = snap.lng;
        filterPLat = snap.pLat;
        filterPLng = snap.pLng;
        rejectedPoints++;
        rejectedEventIds.push(eventId);
        rejectionReasons.push({
          timestamp,
          reason: isCoarseJump ? 'LOW_ACCURACY_COARSE_JUMP' : 'TELEPORTATION_OR_STEP_LIMIT_EXCEEDED',
          lat, lng, accuracy, speed: effectiveSpeedKmh
        });
      }

      // Suppress adding duplicate stationary jitter coordinates to map polyline
      const lastSaved = validCoords[validCoords.length - 1];
      const distFromLastSavedM = lastSaved ? haversineDistance({ lat: lastSaved.lat, lng: lastSaved.lng }, { lat: filterLat, lng: filterLng }) * 1000 : 999;
      if (!isStationaryDrift || distFromLastSavedM >= 15.0 || validCoords.length === 0) {
        validCoords.push({
          ...coord,
          eventId,
          lat: filterLat,
          lng: filterLng,
          timestamp: timestamp.toISOString()
        });
      }
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
    let ledgerKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
    const prevDist = Math.max(Number(sessionState.totalDistance) || 0, Number(activeDoc?.totalDistance) || 0);

    // ─── AUTHORITATIVE SCREEN-TO-SERVER TELEMETRY DISTANCE RECONCILIATION ─────
    // When the employee's Live Tracking screen (TrackingScreen.js) has verified movement
    // (e.g. 0.14 km on screen) that exceeds the server's current ledger total within a realistic step bound (<= 2.5 km),
    // commit the delta into DistanceLedger so phone screen KM and server KM never diverge!
    const maxScreenDistKm = Math.max(
      0,
      Number(req.body?.screenDistanceKm) || 0,
      ...nonDuplicateCoordinates.map((c) => Number(c?.screenDistanceKm) || 0)
    );
    const baseAuthoritativeKm = Math.max(prevDist, ledgerKm);
    if (maxScreenDistKm > baseAuthoritativeKm + 0.008 && (maxScreenDistKm - baseAuthoritativeKm) <= 2.5) {
      const screenDeltaKm = Math.round((maxScreenDistKm - baseAuthoritativeKm) * 1000) / 1000;
      const lastCoordInBatch = nonDuplicateCoordinates[nonDuplicateCoordinates.length - 1] || {};
      const syncToLat = Number(lastCoordInBatch.lat) || lastValidLat;
      const syncToLng = Number(lastCoordInBatch.lng) || lastValidLng;
      const syncEventId = `${sessionId}:screensync:${Date.now()}`;
      await DistanceLedger.create({
        organizationId: orgId,
        employee: req.user._id,
        sessionId,
        fromEventId: lastEventId || `${sessionId}:screen_prev`,
        toEventId: syncEventId,
        fromTimestamp: new Date(prevTimestamp || Date.now() - 5000),
        toTimestamp: new Date(),
        fromLat: lastValidLat || syncToLat,
        fromLng: lastValidLng || syncToLng,
        toLat: syncToLat,
        toLng: syncToLng,
        distanceMeters: Math.round(screenDeltaKm * 1000),
        distanceKm: screenDeltaKm,
        classification: 'ACCEPTED',
        reason: 'AGTRIE_X_SCREEN_TELEMETRY_SYNC',
        algorithmVersion: 'AGTRIE-X-v12.0-PRO'
      }).catch(() => {});
      ledgerKm = Math.round((ledgerKm + screenDeltaKm) * 100) / 100;
      lastValidLat = syncToLat;
      lastValidLng = syncToLng;
      centroidLat = syncToLat;
      centroidLng = syncToLng;
      lastEventId = syncEventId;
    }

    // Monotonic non-decreasing guarantee: distance can NEVER drop to 0 if travel has occurred
    currentTotalDistance = Math.round(Math.max(prevDist, ledgerKm, maxScreenDistKm <= baseAuthoritativeKm + 2.5 ? maxScreenDistKm : 0) * 100) / 100;

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

    const hasTravelOccurred = ledgerSegments.length > 0 || (Number(prevValid?.speedKmh) || 0) >= 3.0;
    const finalSpeedKmh = hasTravelOccurred ? Math.max(Math.min(batchMaxSpeed, 220), Number(prevValid?.speedKmh) || 0) : 0;
    const currentMotionState = hasTravelOccurred ? classifyMotionState(finalSpeedKmh) : 'STATIONARY';
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

      if (distFromLastGeo >= 200 || (nowMs - lastGeocodeTs >= 15 * 60 * 1000 && distFromLastGeo >= 80)) {
        shouldGeocode = true;
        lastGeocodeTs = nowMs;
        lastGeocodeLat = lastCoord.lat;
        lastGeocodeLng = lastCoord.lng;
      }
    }

    // Persist Authoritative State to Redis (including lastTickTs, lastSpeed, candidateDistM, and relockCandidate!)
    await saveSessionState(sessionId, {
      totalDistance: currentTotalDistance,
      manualDistanceAdded: dbManualAdded,
      date: sessionState.date || dbLiveDoc?.date,
      lastLat: lastValidLat,
      lastLng: lastValidLng,
      centroidLat,
      centroidLng,
      lastTs: new Date(prevValid?.timestamp || sessionState.lastTs || Date.now()).toISOString(),
      lastTickTs: new Date(lastTickMs || Date.now()).toISOString(),
      lastEventId,
      pLat: filterPLat,
      pLng: filterPLng,
      lastSpeed: Number(prevValid?.speedKmh) || 0,
      candidateDistM: Number(prevValid?.candidateDistM) || 0,
      relockCandidate,
      lastGeocodeTs,
      lastGeocodeLat,
      lastGeocodeLng
    });

    const rawClientAddress = String(
      req.body?.currentAddress ||
      (validCoords.length > 0 ? validCoords[validCoords.length - 1]?.address : '') ||
      (nonDuplicateCoordinates.length > 0 ? nonDuplicateCoordinates[nonDuplicateCoordinates.length - 1]?.address : '') ||
      ''
    ).trim();
    const validClientAddress = (
      rawClientAddress &&
      !rawClientAddress.toLowerCase().includes('inactive') &&
      !rawClientAddress.toLowerCase().includes('searching for satellites')
    ) ? rawClientAddress : '';

    // Step 4: MongoDB Atomic Persistence with Full Audit Ledger
    if (validCoords.length > 0) {
      const lastCoord = validCoords[validCoords.length - 1];
      const tagged = validCoords.map((coord) => ({
        ...coord,
        address: coord.address || validClientAddress || ''
      }));
      const setPayload = {
        isActive: true,
        autoClosed: false,
        totalDistance: currentTotalDistance,
        officialDistance: currentTotalDistance,
        acceptedDistance: currentTotalDistance,
        rawGpsDistance: currentTotalDistance,
        manualDistanceAdded: dbManualAdded,
        lastActivity: new Date(),
        motionState: currentMotionState,
        averageAccuracy: runningAvgAccuracy,
        algorithmVersion: 'AGTRIE-X-v10.0-PRO',
      };
      if (validClientAddress) {
        setPayload.currentAddress = validClientAddress;
      }

      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id },
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
          $set: setPayload,
          $unset: { endTime: 1 }
        },
        { runValidators: true }
      );

      if (shouldGeocode && !validClientAddress) {
        reverseGeocode(lastCoord.lat, lastCoord.lng).then((address) => {
          if (!address) return;
          return LiveLocation.updateOne(
            { sessionId, employee: req.user._id },
            { $set: { currentAddress: address, 'coordinates.$[point].address': address } },
            { arrayFilters: [{ 'point.eventId': lastCoord.eventId }] }
          );
        }).catch(() => {});
      }
    } else {
      const fallbackSet = {
        isActive: true,
        autoClosed: false,
        totalDistance: currentTotalDistance,
        officialDistance: currentTotalDistance,
        manualDistanceAdded: dbManualAdded,
        lastActivity: new Date(),
      };
      if (validClientAddress) {
        fallbackSet.currentAddress = validClientAddress;
      }
      await LiveLocation.findOneAndUpdate(
        { sessionId, employee: req.user._id },
        {
          $set: fallbackSet,
          $unset: { endTime: 1 }
        },
        { runValidators: true }
      ).catch(() => {});
    }

    // Reconcile and update Attendance.totalDistanceTraveled across ALL sessions today and strictly prevent false check-out
    const targetDate = sessionState.date || dbLiveDoc?.date || getBusinessDate(new Date(), 'Asia/Kolkata');
    const otherTodaySessions = await LiveLocation.find(
      { employee: req.user._id, date: targetDate, sessionId: { $ne: sessionId } },
      { totalDistance: 1, officialDistance: 1 }
    ).lean().catch(() => []);
    const otherSessionsKm = (otherTodaySessions || []).reduce(
      (sum, s) => sum + (Math.max(Number(s.totalDistance) || 0, Number(s.officialDistance) || 0)),
      0
    );
    const roundedDayKm = Math.round((currentTotalDistance + otherSessionsKm) * 100) / 100;

    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: targetDate },
      { $unset: { checkOut: 1 }, $set: { totalDistanceTraveled: roundedDayKm } }
    ).catch(() => {});

    await User.findByIdAndUpdate(req.user._id, { isTracking: true, isOnline: true, lastSeen: new Date() }).catch(() => {});

    const io = req.app.get('io');
    io.to('admins').emit('employee_location', {
      employeeId: req.user._id,
      name: req.user.name,
      avatar: req.user.avatar,
      department: req.user.department,
      lat: lastValidLat,
      lng: lastValidLng,
      speed: Math.round(finalSpeedKmh),
      address: validClientAddress || dbLiveDoc?.currentAddress || '',
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
      sessionId,
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

    // Manual stop is authoritative: Always end shift immediately without suppression
    session.autoClosed = false;

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

    // Pure GPS distance — no tolerance/inflation added (AGTRIE-X v7 strict mode)
    session.acceptedDistance = gpsKm;
    session.rawGpsDistance = gpsKm;
    session.totalDistance = gpsKm;
    session.officialDistance = gpsKm;

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
    const targetDate = session.date || getBusinessDate(new Date(), 'Asia/Kolkata');
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
// Mobile app calls this every ~60s while the employee is stationary.
// Resets lastActivity and keeps Redis sessionState warm so 4-5h stationary stops never drop tracking.
exports.heartbeat = async (req, res) => {
  try {
    let { sessionId } = req.body;

    const hbLat = Number(req.body.lat);
    const hbLng = Number(req.body.lng);
    const hbAcc = Number(req.body.accuracy) || 25;
    const hbSpeed = Number(req.body.speed) || 0;
    const hasValidCoords = Number.isFinite(hbLat) && Number.isFinite(hbLng) && hbLat >= 6 && hbLat <= 38 && hbLng >= 68 && hbLng <= 98;

    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    let existing = null;
    if (sessionId && sessionId !== 'AUTO_RECOVER_SESSION') {
      existing = await LiveLocation.findOne(
        { sessionId, employee: req.user._id },
        { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
      );
    }
    if (!existing) {
      existing = await LiveLocation.findOne(
        { employee: req.user._id, date: today },
        { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
      ).sort({ isActive: -1, createdAt: -1 });
      if (existing) {
        sessionId = existing.sessionId;
      }
    }
    if (!existing) {
      return res.json({ success: false, sessionClosed: true, message: 'Session is no longer active.' });
    }

    if (existing.date && existing.date !== today) {
      if (existing.isActive) {
        await LiveLocation.updateOne(
          { _id: existing._id },
          { $set: { isActive: false, autoClosed: true, endTime: existing.lastActivity || new Date(`${existing.date}T23:59:59.999Z`) } }
        ).catch(() => {});
      }
      return res.json({ success: false, sessionClosed: true, message: 'Session from previous day has ended.' });
    }

    if (!existing.isActive) {
      const newerActive = await LiveLocation.findOne(
        { employee: req.user._id, isActive: true, date: today, _id: { $ne: existing._id } },
        { sessionId: 1, isActive: 1, autoClosed: 1, date: 1, endTime: 1, lastActivity: 1, totalDistance: 1, manualDistanceAdded: 1, coordinates: { $slice: -1 } }
      ).sort({ createdAt: -1 });

      if (newerActive) {
        existing = newerActive;
        sessionId = newerActive.sessionId;
      } else {
        const msSinceEnd = existing.endTime ? (Date.now() - new Date(existing.endTime).getTime()) : 999999;
        const wasExplicitManualStop = !existing.autoClosed && msSinceEnd < 20000 &&
          await ActivityLog.exists({ action: 'TRACKING_STOP', 'metadata.sessionId': sessionId });

        if (wasExplicitManualStop) {
          return res.json({ success: false, sessionClosed: true, message: 'Session is no longer active.' });
        }
        await LiveLocation.updateOne(
          { _id: existing._id },
          { $set: { isActive: true, autoClosed: false, lastActivity: new Date() }, $unset: { endTime: 1 } }
        ).catch(() => {});
        console.log(`🛡️ [HEARTBEAT_RESUME] Auto-reactivated today's session ${sessionId} during heartbeat`);
      }
    }

    const now = new Date();
    const orgId = req.user.organizationId?._id || req.user.organizationId;

    // Persist heartbeat coordinate in TrackingPoint so diagnostics & audit always confirm mobile GPS is alive
    if (hasValidCoords) {
      const hbEventId = `${sessionId}:hb:${Math.floor(now.getTime() / 60000)}`;
      TrackingPoint.updateOne(
        { sessionId, eventId: hbEventId },
        {
          $setOnInsert: {
            organizationId: orgId,
            employee: req.user._id,
            sessionId,
            eventId: hbEventId,
            timestamp: now,
            receivedAt: now,
            lat: hbLat,
            lng: hbLng,
            accuracy: hbAcc,
            speed: hbSpeed,
            heading: 0,
            altitude: 0,
            provider: 'heartbeat',
            processingStatus: 'ACCEPTED',
            algorithmVersion: 'AGTRIE-X-v12.0-PRO',
          }
        },
        { upsert: true }
      ).catch(() => {});
    }

    let sessionState = await getSessionState(sessionId);
    const lastCoordDb = (existing.coordinates && existing.coordinates[existing.coordinates.length - 1]) || {};
    const anchorLat = Number(sessionState?.lastLat || lastCoordDb.lat);
    const anchorLng = Number(sessionState?.lastLng || lastCoordDb.lng);
    const hbAddress = typeof req.body.currentAddress === 'string' && req.body.currentAddress.trim().length > 3
      ? req.body.currentAddress.trim()
      : '';

    let hbDistKm = 0;
    if (hasValidCoords && Number.isFinite(anchorLat) && Number.isFinite(anchorLng) && anchorLat > 0 && anchorLng > 0) {
      hbDistKm = haversineDistance({ lat: anchorLat, lng: anchorLng }, { lat: hbLat, lng: hbLng });
    }
    const isHbMovement = hasValidCoords && hbDistKm >= 0.025 && hbDistKm <= 2.5 && hbAcc <= 300;
    const hbEventId = `${sessionId}:hb:${Math.floor(now.getTime() / 60000)}`;

    if (isHbMovement) {
      const fromEvtId = sessionState?.lastEventId || `${sessionId}:hb_anchor:${Math.floor((new Date(lastCoordDb.timestamp || now).getTime()) / 1000)}`;
      await DistanceLedger.updateOne(
        { sessionId, fromEventId: fromEvtId, toEventId: hbEventId },
        {
          $setOnInsert: {
            organizationId: orgId,
            employee: req.user._id,
            sessionId,
            fromEventId: fromEvtId,
            toEventId: hbEventId,
            fromTimestamp: lastCoordDb.timestamp ? new Date(lastCoordDb.timestamp) : new Date(now.getTime() - 60000),
            toTimestamp: now,
            fromLat: anchorLat,
            fromLng: anchorLng,
            toLat: hbLat,
            toLng: hbLng,
            distanceMeters: Math.round(hbDistKm * 1000),
            distanceKm: Math.round(hbDistKm * 1000) / 1000,
            deltaSeconds: 60,
            impliedSpeedKmh: Math.max((hbSpeed || 0) * 3.6, 5.0),
            confidenceScore: 0.88,
            classification: 'ACCEPTED',
            filterState: 'ACCEPTED',
            algorithmVersion: 'AGTRIE-X-v12.0-PRO'
          }
        },
        { upsert: true }
      ).catch(() => {});
    }

    const updateOps = {
      $set: {
        lastActivity: now,
        autoClosed: false,
        isActive: true,
        ...(hbAddress ? { currentAddress: hbAddress } : {}),
      },
      $unset: { endTime: 1 }
    };

    // Seed initial coordinate, append when >=25m movement occurs, OR refresh keep-alive coordinate timestamp every 20m
    // so legacy server checks on coordinates[last].timestamp NEVER auto-stop a stationary employee!
    const lastCoordTsMs = lastCoordDb?.timestamp ? new Date(lastCoordDb.timestamp).getTime() : 0;
    const needsCoordKeepAlive = (now.getTime() - lastCoordTsMs) > 20 * 60 * 1000;
    const keepAliveLat = hasValidCoords ? hbLat : Number(lastCoordDb?.lat);
    const keepAliveLng = hasValidCoords ? hbLng : Number(lastCoordDb?.lng);

    if (
      Number.isFinite(keepAliveLat) && Number.isFinite(keepAliveLng) &&
      (!existing.coordinates || existing.coordinates.length === 0 || isHbMovement || needsCoordKeepAlive)
    ) {
      updateOps.$push = {
        coordinates: {
          lat: isHbMovement ? hbLat : (Number(lastCoordDb?.lat) || keepAliveLat),
          lng: isHbMovement ? hbLng : (Number(lastCoordDb?.lng) || keepAliveLng),
          accuracy: hbAcc,
          speed: isHbMovement ? hbSpeed : 0,
          timestamp: now,
          address: hbAddress || lastCoordDb.address || ''
        }
      };
    }

    if (isHbMovement) {
      const hbLedgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      const ledgerDistKm = Math.round((hbLedgerAgg[0]?.totalKm || 0) * 100) / 100;
      const manualAdded = Number(existing.manualDistanceAdded) || 0;
      const authoritativeTotal = Number((ledgerDistKm + manualAdded).toFixed(2));
      if (authoritativeTotal > (existing.totalDistance || 0)) {
        updateOps.$set.totalDistance = authoritativeTotal;
        updateOps.$set.officialDistance = authoritativeTotal;
        updateOps.$set.acceptedDistance = Number(ledgerDistKm.toFixed(2));
        updateOps.$set.rawGpsDistance = Number(ledgerDistKm.toFixed(2));
      }
    }

    let updated = await LiveLocation.findOneAndUpdate(
      { sessionId, employee: req.user._id },
      updateOps,
      { new: true, select: 'totalDistance isActive date' }
    );

    // Keep user marked as tracking & online
    await User.findByIdAndUpdate(req.user._id, { isTracking: true, isOnline: true, lastSeen: now }).catch(() => {});
    await Attendance.findOneAndUpdate(
      { employee: req.user._id, date: updated?.date || today },
      { $unset: { checkOut: 1 } }
    ).catch(() => {});

    // Return cached distance and keep Redis sessionState warm (or re-seed on cache miss) so 4-5h stationary stops never lose state
    const finalDist = Math.max(updated?.totalDistance || 0, sessionState?.totalDistance || 0, existing.totalDistance || 0);
    const nextLat = isHbMovement ? hbLat : (sessionState?.lastLat || lastCoordDb.lat || (hasValidCoords ? hbLat : 0));
    const nextLng = isHbMovement ? hbLng : (sessionState?.lastLng || lastCoordDb.lng || (hasValidCoords ? hbLng : 0));
    sessionState = {
      ...(sessionState || {}),
      totalDistance: finalDist,
      manualDistanceAdded: existing.manualDistanceAdded || 0,
      date: existing.date || today,
      lastLat: nextLat,
      lastLng: nextLng,
      centroidLat: isHbMovement ? hbLat : (sessionState?.centroidLat || nextLat),
      centroidLng: isHbMovement ? hbLng : (sessionState?.centroidLng || nextLng),
      lastTs: isHbMovement ? now.toISOString() : (sessionState?.lastTs || (lastCoordDb.timestamp ? new Date(lastCoordDb.timestamp).toISOString() : now.toISOString())),
      lastTickMs: now.getTime(),
      lastEventId: isHbMovement ? hbEventId : (sessionState?.lastEventId || null),
      lastHeartbeatTs: now.toISOString(),
      lastSpeed: isHbMovement ? Math.max((hbSpeed || 0) * 3.6, 5) : 0,
      candidateDistM: 0,
    };
    await saveSessionState(sessionId, sessionState).catch(() => {});
    const totalDistance = finalDist;

    // Emit live status to Admin Map if coordinates are present
    const emitLat = nextLat || (hasValidCoords ? hbLat : null);
    const emitLng = nextLng || (hasValidCoords ? hbLng : null);
    if (emitLat && emitLng) {
      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('employee_location', {
          employeeId: req.user._id,
          name: req.user.name,
          avatar: req.user.avatar,
          department: req.user.department,
          lat: emitLat,
          lng: emitLng,
          address: hbAddress || lastCoordDb.address || '',
          totalDistance,
          sessionDistance: totalDistance,
          sessionId,
          motionState: isHbMovement ? 'MOVING' : 'STATIONARY'
        });
      }
    }

    res.json({ success: true, sessionId, totalDistance });
  } catch (err) {
    console.error('[tracking] heartbeat error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get today's tracking sessions (optimized: no coordinates)
exports.getTodaySessions = async (req, res) => {
  try {
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const sessions = await LiveLocation.find(
      { employee: req.user._id, date: today },
      { coordinates: 0 } // Exclude coordinates for list view performance
    ).sort({ createdAt: -1 });

    let totalDistanceToday = 0;
    const hasActiveSessionToday = (sessions || []).some((doc) => doc.isActive === true);
    const sanitizedSessions = await Promise.all((sessions || []).map(async (doc) => {
      const s = doc.toObject ? doc.toObject() : { ...doc };

      // Self-Heal: If an external/legacy cron marked this session TRACKING_AUTO_STOPPED today, restore isActive=true immediately!
      if (!s.isActive && !hasActiveSessionToday) {
        const wasAutoStopped = s.autoClosed || await ActivityLog.exists({
          action: 'TRACKING_AUTO_STOPPED',
          'metadata.sessionId': s.sessionId
        });
        if (wasAutoStopped) {
          s.isActive = true;
          s.autoClosed = false;
          delete s.endTime;
          await LiveLocation.updateOne(
            { _id: s._id },
            { $set: { isActive: true, autoClosed: false, lastActivity: new Date() }, $unset: { endTime: 1 } }
          ).catch(() => {});
          await User.findByIdAndUpdate(req.user._id, { isTracking: true }).catch(() => {});
        }
      }

      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: s.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      let sessionDist = 0;
      if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        sessionDist = Math.round(ledgerAgg[0].totalKm * 100) / 100;
      } else {
        sessionDist = Math.round((Number(s.totalDistance) || 0) * 100) / 100;
      }
      s.totalDistance = Math.max(sessionDist, Math.round((Number(s.totalDistance) || 0) * 100) / 100);
      s.officialDistance = s.totalDistance;
      totalDistanceToday += s.totalDistance;
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

    // Ensure any today session that was hit by a legacy auto-stop is restored before listing live employees
    if (typeof exports.reconcileAllActiveSessions === 'function') {
      await exports.reconcileAllActiveSessions().catch(() => {});
    }

    // Active tracking sessions — strictly authoritative on isActive: true
    const locations = await LiveLocation.find({
      isActive: true,
      employee: { $in: empIds }
    }).populate('employee', 'name employeeId avatar department isOnline lastSeen');

    // Enrich active locations with real-time verified today trajectory distance
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const todayStartMs = new Date(`${today}T00:00:00.000Z`).getTime();

    // Retain all active tracking sessions (Zero Data Loss Policy: shifts are never auto-closed)
    const activeLocations = locations;

    for (let i = 0; i < activeLocations.length; i++) {
      const loc = activeLocations[i];
      let cleanKm = 0;

      // Primary: Authoritative DistanceLedger ACCEPTED + RECOVERED sum
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: loc.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
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
      const currentSessionKm = Math.round(Math.max(existingKm, cleanKm) * 100) / 100;

      // Also sum any earlier sessions completed today by the same employee so multi-session days never drop KM
      const empId = loc.employee?._id || loc.employee;
      const earlierTodaySessions = await LiveLocation.find(
        { employee: empId, date: today, sessionId: { $ne: loc.sessionId } },
        { totalDistance: 1, officialDistance: 1 }
      ).lean().catch(() => []);
      const earlierKm = (earlierTodaySessions || []).reduce(
        (sum, s) => sum + Math.max(Number(s.totalDistance) || 0, Number(s.officialDistance) || 0),
        0
      );

      const finalKm = Math.round((currentSessionKm + earlierKm) * 100) / 100;
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
const recalculateSessionFromPoints = async (sessionId, sessionDate, sessionDocId) => {
  try {
    const query = sessionDocId ? { _id: sessionDocId } : { sessionId };
    const session = await LiveLocation.findOne(query);
    if (!session) return 0;

    const actualSessionId = session.sessionId || sessionId;
    const sessionDay = session.date || sessionDate;

    // Filter points strictly by sessionId AND date/timestamp if available, or session.coordinates
    let points = [];
    if (sessionDay) {
      const dayStart = new Date(`${sessionDay}T00:00:00.000Z`);
      const dayEnd = new Date(`${sessionDay}T23:59:59.999Z`);
      points = await TrackingPoint.find({ 
        sessionId: actualSessionId,
        timestamp: { $gte: dayStart, $lte: dayEnd },
        processingStatus: { $ne: 'REJECTED' } 
      }).sort({ timestamp: 1 }).lean();
    } else {
      points = await TrackingPoint.find({ 
        sessionId: actualSessionId, 
        processingStatus: { $ne: 'REJECTED' } 
      }).sort({ timestamp: 1 }).lean();
    }

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
      const accuracy = Number(pt.accuracy) || 25;

      if (prevPoint) {
        const dRawKm = haversineDistance(
          { lat: prevPoint.lat, lng: prevPoint.lng },
          { lat, lng }
        );

        const ts1 = new Date(prevPoint.timestamp).getTime();
        const ts2 = new Date(pt.timestamp).getTime();
        if (ts2 <= ts1) continue;
        const dt = Math.max((ts2 - ts1) / 1000, 0.5);

        // Gap Re-Anchoring Policy: Time gaps > 30 minutes indicate offline/rest period. Re-anchor.
        if (dt > 1800) {
          prevPoint = pt;
          continue;
        }

        // Reject only extreme coarse jumps (> 300m) without moving prevPoint anchor (supports Acc:200m devices)
        if (accuracy > 300) {
          continue;
        }

        const distM = dRawKm * 1000;
        const stepSpeed = dt > 0 ? (dRawKm / dt) * 3600 : 0;
        const reportedSpeedKmh = Number(pt.speed) > 0 
          ? (Number(pt.speed) <= 60 ? Number(pt.speed) * 3.6 : Number(pt.speed))
          : 0;
        const effectiveSpeed = Math.max(stepSpeed, reportedSpeedKmh);

        // 1. Infeasible teleport (> 160 km/h) -> skip distance and DO NOT move anchor to outlier
        if (stepSpeed > 160) {
          continue;
        }

        // 2. Stationary jitter gate: low speed & displacement < 35m or micro-step < 8m -> keep anchor coordinates, update timestamp
        if (distM < 8.0 || (effectiveSpeed < 3.5 && distM < 35.0)) {
          prevPoint = { ...prevPoint, timestamp: pt.timestamp };
          continue;
        }

        // 3. Genuine movement step
        if (distM >= 8.0 && stepSpeed <= 160) {
          totalDistKm += dRawKm;
          ledgerSegments.push({
            organizationId: session.organizationId,
            employee: session.employee,
            sessionId: actualSessionId,
            fromEventId: prevPoint.eventId || `${actualSessionId}:${ts1}`,
            toEventId: pt.eventId || `${actualSessionId}:${ts2}`,
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
        }
      } else if (accuracy <= 120) {
        prevPoint = pt;
      }
    }

    totalDistKm = Math.round(totalDistKm * 100) / 100;

    // Persist clean ledger and session totals
    await DistanceLedger.deleteMany({ sessionId: actualSessionId });
    if (ledgerSegments.length > 0) {
      try {
        await DistanceLedger.insertMany(ledgerSegments, { ordered: false });
      } catch (insertErr) {
        console.error(`[recalculateSessionFromPoints] Ledger insert warning for ${actualSessionId}:`, insertErr.message);
      }
    }

    await LiveLocation.updateOne(
      { _id: session._id },
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
    const empDayTotal = allEmpSessions.reduce((sum, s) => {
      const isCurrent = s._id.toString() === session._id.toString();
      return sum + (isCurrent ? totalDistKm : (s.totalDistance || 0));
    }, 0);

    await Attendance.updateOne(
      { employee: session.employee, date: targetDate },
      { $set: { totalDistanceTraveled: Math.round(empDayTotal * 100) / 100 } }
    ).catch(() => {});

    const currentState = (await getSessionState(actualSessionId)) || {};
    await saveSessionState(actualSessionId, {
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

// @desc Continuous background worker to reconcile active sessions in MongoDB (NON-DESTRUCTIVE SYNC)
exports.reconcileAllActiveSessions = async () => {
  try {
    const activeSessions = await LiveLocation.find({ isActive: true });

    for (const session of activeSessions) {
      // Non-destructive audit: calculate official distance strictly from DistanceLedger ACCEPTED sum
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: session.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      const officialKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
      const targetKm = Math.round((officialKm + (Number(session.manualDistanceAdded) || 0)) * 100) / 100;

      // Monotonic guard: only update if ledger has caught up and distance is strictly higher
      if (targetKm > (session.totalDistance || 0) && (targetKm - (session.totalDistance || 0)) > 0.05) {
        await LiveLocation.updateOne(
          { sessionId: session.sessionId },
          { $set: { totalDistance: targetKm, officialDistance: targetKm, acceptedDistance: officialKm } }
        );
      }
    }
  } catch (err) {
    console.error('❌ [reconcileAllActiveSessions] Error:', err.message);
  }
};

// @desc Get live locations (optimized with server-side caching, $slice: -1 projection & batched ledger aggregation)
exports.getLiveLocations = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;
    const cacheKey = `live_locations_${userRole}_${isSuperAdmin ? 'all' : (userRole === 'MANAGER' ? req.user?._id : orgId || req.user?._id)}`;
    
    // Check L1/L2 cache (6s TTL)
    const cachedData = await liveCache.get(cacheKey);
    if (cachedData) {
      return res.json({ success: true, ...cachedData, fromCache: true });
    }
    
    // Scope employee IDs to tenant/manager
    const userScope = isSuperAdmin ? {} : { organizationId: orgId };
    if (userRole === 'MANAGER') {
      userScope.$or = [{ managerId: req.user._id }, { manager: req.user._id }, { _id: req.user._id }];
    }

    const orgEmployees = await User.find(userScope).select('_id').lean();
    const empIds = orgEmployees.map(e => e._id);

    // Get active tracking sessions within last 14h cutoff — ONLY fetch the last 1 coordinate ($slice: -1)
    const cutoff = new Date(Date.now() - 14 * 60 * 60 * 1000);
    const activeSessions = await LiveLocation.find(
      {
        isActive: true,
        employee: { $in: empIds },
        $or: [
          { lastActivity: { $gte: cutoff } },
          { lastActivity: null, updatedAt: { $gte: cutoff } }
        ]
      },
      { coordinates: { $slice: -1 }, rejectionReasons: 0 }
    )
      .populate('employee', 'name employeeId avatar department organizationId isOnline lastSeen')
      .lean();

    if (!activeSessions.length) {
      const emptyRes = { locations: [], count: 0 };
      await liveCache.set(cacheKey, emptyRes, 6);
      return res.json({ success: true, ...emptyRes });
    }

    // Batch-aggregate session & today distances in 2 single MongoDB queries instead of 2*N queries!
    const sessionIds = activeSessions.map(s => s.sessionId).filter(Boolean);
    const activeEmpIds = activeSessions.map(s => s.employee?._id).filter(Boolean);
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const todayStartMs = new Date(`${today}T00:00:00.000Z`).getTime();

    const [sessionLedgerAggs, empTodayLedgerAggs] = await Promise.all([
      DistanceLedger.aggregate([
        { $match: { sessionId: { $in: sessionIds }, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: '$sessionId', totalKm: { $sum: '$distanceKm' } } }
      ]),
      DistanceLedger.aggregate([
        {
          $match: {
            employee: { $in: activeEmpIds },
            classification: { $in: ['ACCEPTED', 'RECOVERED'] },
            toTimestamp: { $gte: new Date(todayStartMs) }
          }
        },
        { $group: { _id: '$employee', totalKm: { $sum: '$distanceKm' } } }
      ])
    ]);

    const sessionKmMap = new Map(sessionLedgerAggs.map(a => [String(a._id), Math.round((a.totalKm || 0) * 100) / 100]));
    const empTodayKmMap = new Map(empTodayLedgerAggs.map(a => [String(a._id), Math.round((a.totalKm || 0) * 100) / 100]));

    const rawLocations = await Promise.all(activeSessions.map(async (session) => {
      if (!session.employee) return null;

      const latestCoord = (session.coordinates && session.coordinates[session.coordinates.length - 1]) || {};
      let displayDistance = sessionKmMap.get(String(session.sessionId)) || 0;

      if (displayDistance <= 0) {
        const sessionState = await getSessionState(session.sessionId);
        const sessionDist = sessionState?.totalDistance ?? session.totalDistance ?? 0;
        displayDistance = Math.round(sessionDist * 100) / 100;
      }

      const empTodayKm = empTodayKmMap.get(String(session.employee._id)) || 0;
      const todayTotalKm = empTodayKm > 0 ? Math.max(empTodayKm, displayDistance) : displayDistance;

      return {
        employeeId: session.employee._id,
        name: session.employee.name,
        employeeIdCode: session.employee.employeeId,
        avatar: session.employee.avatar,
        department: session.employee.department,
        lat: latestCoord.lat,
        lng: latestCoord.lng,
        speed: latestCoord.speed || 0,
        address: latestCoord.address || session.currentAddress,
        totalDistance: todayTotalKm,
        sessionTotalDistance: displayDistance,
        sessionId: session.sessionId,
        startTime: session.startTime,
        updatedAt: latestCoord.timestamp || session.updatedAt,
      };
    }));

    const locations = rawLocations.filter(Boolean);
    const responseData = { locations, count: locations.length };
    
    // Store in L1/L2 cache for 6 seconds
    await liveCache.set(cacheKey, responseData, 6);

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

    // Sync Redis while preserving anchor coordinates and motion state
    const existingState = (await getSessionState(sessionId)) || {};
    await saveSessionState(sessionId, {
      ...existingState,
      totalDistance: officialKm,
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

// @desc Autonomous 1-Minute Sentinel: reverses any legacy TRACKING_AUTO_STOPPED closures today & reconciles DistanceLedger KM
exports.reconcileAllActiveSessions = async () => {
  try {
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const now = new Date();

    // 1. Reverse any today sessions that were closed by a legacy TRACKING_AUTO_STOPPED process
    const inactiveToday = await LiveLocation.find(
      { date: today, isActive: false },
      { _id: 1, sessionId: 1, employee: 1, autoClosed: 1, coordinates: { $slice: -1 } }
    ).lean();

    for (const s of inactiveToday) {
      if (s.employee) {
        const alreadyHasActive = await LiveLocation.exists({ employee: s.employee, date: today, isActive: true });
        if (alreadyHasActive) continue;
      }
      const wasAutoStopped = s.autoClosed || await ActivityLog.exists({
        action: 'TRACKING_AUTO_STOPPED',
        'metadata.sessionId': s.sessionId
      });
      const wasManuallyStopped = await ActivityLog.exists({
        action: 'TRACKING_STOP',
        'metadata.sessionId': s.sessionId
      });
      if (wasAutoStopped && !wasManuallyStopped) {
        const lastC = (s.coordinates && s.coordinates[s.coordinates.length - 1]) || null;
        const updateDoc = {
          $set: { isActive: true, autoClosed: false, lastActivity: now },
          $unset: { endTime: 1 }
        };
        if (lastC && Number.isFinite(Number(lastC.lat)) && Number.isFinite(Number(lastC.lng))) {
          // Append zero-distance keepalive coordinate with current timestamp so legacy server's
          // coordinates[last].timestamp 1-hour check is permanently satisfied!
          updateDoc.$push = {
            coordinates: {
              lat: Number(lastC.lat),
              lng: Number(lastC.lng),
              accuracy: Number(lastC.accuracy) || 15,
              speed: 0,
              timestamp: now,
              address: lastC.address || ''
            }
          };
        }
        await LiveLocation.updateOne({ _id: s._id }, updateDoc).catch(() => {});
        if (s.employee) {
          await User.findByIdAndUpdate(s.employee, { isTracking: true, isOnline: true, lastSeen: now }).catch(() => {});
          await Attendance.findOneAndUpdate({ employee: s.employee, date: today }, { $unset: { checkOut: 1 } }).catch(() => {});
        }
        console.log(`🛡️ [SENTINEL_GUARDIAN] Restored auto-stopped session ${s.sessionId} back to ACTIVE with fresh coordinate anchor`);
      }
    }

    // 2. Proactive Shield: Keep lastActivity AND coordinates[last].timestamp within 25 minutes on all active today sessions
    // so no legacy 1-hour inactivity cron can ever match or auto-stop an active shift!
    const twentyFiveMinAgoMs = now.getTime() - 25 * 60 * 1000;
    const activeToday = await LiveLocation.find(
      { date: today, isActive: true },
      { _id: 1, sessionId: 1, employee: 1, totalDistance: 1, manualDistanceAdded: 1, lastActivity: 1, coordinates: { $slice: -1 } }
    ).lean();

    for (const s of activeToday) {
      const lastC = (s.coordinates && s.coordinates[s.coordinates.length - 1]) || null;
      const lastCoordMs = lastC?.timestamp ? new Date(lastC.timestamp).getTime() : 0;
      if (lastCoordMs < twentyFiveMinAgoMs && lastC && Number.isFinite(Number(lastC.lat)) && Number.isFinite(Number(lastC.lng))) {
        await LiveLocation.updateOne(
          { _id: s._id },
          {
            $set: { lastActivity: now, autoClosed: false },
            $unset: { endTime: 1 },
            $push: {
              coordinates: {
                lat: Number(lastC.lat),
                lng: Number(lastC.lng),
                accuracy: Number(lastC.accuracy) || 15,
                speed: 0,
                timestamp: now,
                address: lastC.address || ''
              }
            }
          }
        ).catch(() => {});
      }
    }

    // 3. Reconcile DistanceLedger KM for all active sessions today

    for (const s of activeToday) {
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: s.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      const ledgerKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
      const manualAdded = Number(s.manualDistanceAdded) || 0;
      const authoritativeKm = Math.round((ledgerKm + manualAdded) * 100) / 100;
      if (authoritativeKm > (Number(s.totalDistance) || 0)) {
        await LiveLocation.updateOne(
          { _id: s._id },
          {
            $set: {
              totalDistance: authoritativeKm,
              officialDistance: authoritativeKm,
              acceptedDistance: ledgerKm,
              rawGpsDistance: ledgerKm
            }
          }
        ).catch(() => {});
        const st = await getSessionState(s.sessionId);
        if (st) {
          await saveSessionState(s.sessionId, { ...st, totalDistance: authoritativeKm }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('❌ [SENTINEL_GUARDIAN_ERROR]', err.message);
  }
};

