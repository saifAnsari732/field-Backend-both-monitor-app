/**
 * advancedGpsEngine.service.js
 * 
 * AGTRIE-X v7.2 Advanced GPS Mathematical Movement Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated service module encapsulating all state-space kinematic math:
 *  1. Local ENU Cartesian Projection (WGS84)
 *  2. 2D Kinematic Kalman Filtering with Huber M-Estimation
 *  3. IMM Motion Classifier (Walking, Running, Bike, Vehicle, Stationary)
 *  4. 7-Vector Master Bayesian Scoring Engine
 *  5. Stationary Drift Clamping (0.000 KM for standing workers)
 *  6. Long-Gap Re-Anchoring (dt > 300s)
 *  7. Immutable Segment Audit Ledger Creation
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  ENUProjection,
  KinematicKalmanFilter,
  IMMMotionEstimator,
  BayesianGPSScorer,
  haversineM
} = require('./trajectoryEngine');

/**
 * Process a batch of incoming GPS coordinates through the advanced mathematical engine
 * @param {String} sessionId 
 * @param {Array} rawCoordinates [{ lat, lng, accuracy, speed, heading, timestamp, eventId }]
 * @param {Object} sessionState { lastLat, lastLng, lastTs, lastEventId, lastSpeed }
 * @returns {Object} { acceptedSegments, rejectedPoints, currentMotionState, newSessionState }
 */
async function processGpsBatch(sessionId, rawCoordinates = [], sessionState = {}) {
  if (!Array.isArray(rawCoordinates) || rawCoordinates.length === 0) {
    return {
      acceptedSegments: [],
      rejectedPoints: [],
      acceptedEventIds: [],
      rejectedEventIds: [],
      currentMotionState: sessionState.lastMotionState || 'STATIONARY',
      newSessionState: sessionState
    };
  }

  // 1. Chronological Sorting & Input Bounds Validation
  const validCoordinates = rawCoordinates
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.lat >= -90 && c.lat <= 90 && c.lng >= -180 && c.lng <= 180)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const acceptedSegments = [];
  const rejectedPoints = [];
  const acceptedEventIds = [];
  const rejectedEventIds = [];

  let lastLat = sessionState.lastLat || (validCoordinates[0] ? validCoordinates[0].lat : 0);
  let lastLng = sessionState.lastLng || (validCoordinates[0] ? validCoordinates[0].lng : 0);
  let lastTs = sessionState.lastTs ? new Date(sessionState.lastTs).getTime() : 0;
  let lastEventId = sessionState.lastEventId || null;
  let maxSpeedKmh = sessionState.lastSpeed || 0;

  // Initialize Kalman Filter state
  let kf = null;
  if (lastLat && lastLng) {
    kf = new KinematicKalmanFilter(lastLat, lastLng);
  }

  for (const c of validCoordinates) {
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    const accuracy = Number(c.accuracy) || 30;
    const speedMps = Number(c.speed) || 0;
    const heading = Number(c.heading) || 0;
    const timestamp = new Date(c.timestamp);
    const tsMs = timestamp.getTime();
    const eventId = c.eventId || `${sessionId}:${tsMs}:${lat.toFixed(6)}:${lng.toFixed(6)}`;

    // Time gap from previous fix
    const dt = lastTs > 0 ? Math.max((tsMs - lastTs) / 1000, 0.5) : 1.0;

    // 2. Long-Gap Re-Anchoring Gate (dt > 300s = 5+ minutes missing)
    if (dt > 300) {
      console.log(`📍 AdvancedGpsEngine: Gap of ${(dt / 60).toFixed(1)}min detected. Re-anchoring trajectory.`);
      lastLat = lat;
      lastLng = lng;
      lastTs = tsMs;
      lastEventId = eventId;
      kf = new KinematicKalmanFilter(lat, lng);
      acceptedEventIds.push(eventId);
      continue; // Re-anchor fix: 0.00 KM added for long gap jump!
    }

    // Initialize Kalman if not present
    if (!kf) {
      kf = new KinematicKalmanFilter(lat, lng);
    }

    // 3. Kalman Filter Predict & Update
    const kfUpdate = kf.update(lat, lng, accuracy, dt);

    // 4. Bayesian GPS Scoring Engine Evaluation
    const currentPoint = { lat, lng, accuracy, speed: speedMps, heading, timestamp };
    const prevPoint = lastLat ? { lat: lastLat, lng: lastLng, timestamp: new Date(lastTs) } : null;
    const bayesianResult = BayesianGPSScorer.scorePoint(currentPoint, prevPoint);

    // 5. IMM Motion State Classifier
    const distM = haversineM(lastLat, lastLng, lat, lng);
    const distKm = distM / 1000;
    const calcSpeedKmh = (distKm / dt) * 3600;
    const effectiveSpeedKmh = Math.max(speedMps * 3.6, calcSpeedKmh);

    if (effectiveSpeedKmh > maxSpeedKmh && effectiveSpeedKmh <= 220) {
      maxSpeedKmh = effectiveSpeedKmh;
    }

    const immState = IMMMotionEstimator.estimate(effectiveSpeedKmh, 0, accuracy);

    // 6. Strict Mathematical Decision Matrix
    const isMovementValid = 
      (bayesianResult.classification === 'ACCEPTED' || bayesianResult.classification === 'RECOVERED') &&
      immState.primaryState !== 'STATIONARY' &&
      distM >= 5.0 &&
      effectiveSpeedKmh <= 220;

    if (isMovementValid) {
      acceptedEventIds.push(eventId);
      acceptedSegments.push({
        sessionId,
        fromEventId: lastEventId,
        toEventId: eventId,
        fromTimestamp: new Date(lastTs),
        toTimestamp: timestamp,
        fromLat: lastLat,
        fromLng: lastLng,
        toLat: lat,
        toLng: lng,
        distanceMeters: Math.round(distM),
        distanceKm: Math.round(distKm * 1000) / 1000,
        classification: bayesianResult.classification,
        reason: bayesianResult.classification === 'RECOVERED' ? 'BAYESIAN_HERMITE_RECOVERY' : 'BAYESIAN_ACCEPTED_STEP',
        motionState: immState.primaryState,
        algorithmVersion: 'AGTRIE-X-v7.2-DURABLE'
      });

      lastLat = lat;
      lastLng = lng;
      lastTs = tsMs;
      lastEventId = eventId;
    } else {
      // Stationary / Jitter Fix: Raw point is saved in TrackingPoint, but ZERO distance added to ledger
      if (bayesianResult.classification === 'REJECTED' && effectiveSpeedKmh > 220) {
        rejectedEventIds.push(eventId);
        rejectedPoints.push({ eventId, lat, lng, reason: 'TELEPORT_EXCEEDS_220_KMH' });
      } else {
        acceptedEventIds.push(eventId); // Marked processed as stationary fix
      }
    }
  }

  const finalMotionState = classifyMotionState(maxSpeedKmh);

  return {
    acceptedSegments,
    rejectedPoints,
    acceptedEventIds,
    rejectedEventIds,
    currentMotionState: finalMotionState,
    newSessionState: {
      lastLat,
      lastLng,
      lastTs: new Date(lastTs).toISOString(),
      lastEventId,
      lastSpeed: maxSpeedKmh,
      lastMotionState: finalMotionState
    }
  };
}

function classifyMotionState(speedKmh) {
  if (speedKmh < 1.0) return 'STATIONARY';
  if (speedKmh < 7.0) return 'WALKING';
  if (speedKmh < 15.0) return 'RUNNING';
  if (speedKmh < 45.0) return 'BIKE';
  return 'VEHICLE';
}

module.exports = {
  processGpsBatch,
  classifyMotionState
};
