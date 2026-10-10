/**
 * reprocess_today_km.js
 * 
 * AUTOMATIC KM FREEZE DETECTOR & BACKLOG REPROCESSOR FOR ALL EMPLOYEES TODAY
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans all sessions for today (or active sessions), re-evaluates all raw
 * TrackingPoint records using the new P0 long-gap re-anchoring engine,
 * generates missing DistanceLedger segments, and updates LiveLocation and Attendance.
 * ─────────────────────────────────────────────────────────────────────────────
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, TrackingPoint, DistanceLedger, Attendance, User } = require('./models/index');
const { saveSessionState } = require('./services/cache.service');

// Haversine distance in KM
function haversineDistance(coord1, coord2) {
  const R = 6371; // Earth radius in km
  const dLat = ((coord2.lat - coord1.lat) * Math.PI) / 180;
  const dLng = ((coord2.lng - coord1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((coord1.lat * Math.PI) / 180) *
      Math.cos((coord2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function reprocessAllEmployeesToday() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('❌ MONGODB_URI not found in environment.');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB.');

    const today = new Date().toISOString().slice(0, 10);
    console.log(`🔍 Scanning active & today sessions for date: ${today}...`);

    const sessions = await LiveLocation.find({
      $or: [{ date: today }, { isActive: true }]
    }).populate('employee', 'name employeeId');

    console.log(`📋 Found ${sessions.length} sessions to check/reprocess.`);

    for (const session of sessions) {
      const sessionId = session.sessionId;
      const empName = session.employee?.name || session.employee || 'Unknown';
      console.log(`\n--------------------------------------------------`);
      console.log(`▶ Processing Employee: ${empName} (Session: ${sessionId})`);

      // Fetch all raw tracking points sorted chronologically
      const rawPoints = await TrackingPoint.find({ sessionId }).sort({ timestamp: 1 }).lean();
      console.log(`  Raw TrackingPoint count: ${rawPoints.length}`);

      if (rawPoints.length === 0) {
        console.log(`  ⚠️ No raw tracking points found for ${empName}.`);
        continue;
      }

      // Existing ledger segments
      const existingLedgers = await DistanceLedger.find({ sessionId }).lean();
      const existingToEventIds = new Set(existingLedgers.map(l => l.toEventId));

      let filterLat = Number(rawPoints[0].lat);
      let filterLng = Number(rawPoints[0].lng);
      let filterPLat = 0.00000001;
      let filterPLng = 0.00000001;
      let lastValidLat = filterLat;
      let lastValidLng = filterLng;
      let centroidLat = filterLat;
      let centroidLng = filterLng;
      let lastEventId = null;
      let prevTimestamp = new Date(rawPoints[0].timestamp).getTime();

      let prev2Valid = null;
      let prevValid = {
        lat: filterLat,
        lng: filterLng,
        latRaw: filterLat,
        lngRaw: filterLat,
        accuracy: Number(rawPoints[0].accuracy) || 20,
        speedKmh: (Number(rawPoints[0].speed) || 0) * 3.6,
        timestamp: new Date(rawPoints[0].timestamp).toISOString(),
        heading: rawPoints[0].heading
      };

      const newLedgerSegments = [];
      let totalRecalculatedKm = 0;

      for (let i = 0; i < rawPoints.length; i++) {
        const pt = rawPoints[i];
        const lat = Number(pt.lat);
        const lng = Number(pt.lng);
        const timestamp = new Date(pt.timestamp);
        const tMs = timestamp.getTime();
        const eventId = pt.eventId || `${sessionId}:${tMs}:${lat.toFixed(6)}:${lng.toFixed(6)}`;
        const accuracy = Number(pt.accuracy) || 30;

        // Skip invalid coordinates or mock locations
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98 || pt.mocked) {
          continue;
        }

        const lastTrustedMs = prevValid?.timestamp ? new Date(prevValid.timestamp).getTime() : prevTimestamp;
        const dt = Math.max((tMs - lastTrustedMs) / 1000, 0.5);

        const R = Math.pow(Math.max(accuracy, 5) / 111320, 2);

        // P0 LONG-GAP RE-ANCHORING LOGIC (> 30 mins)
        if (dt > 1800) {
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

          prev2Valid = prevValid;
          prevValid = {
            lat: filterLat,
            lng: filterLng,
            latRaw: lat,
            lngRaw: lng,
            accuracy,
            speedKmh: (Number(pt.speed) || 0) * 3.6,
            timestamp: timestamp.toISOString(),
            heading: pt.heading
          };
          continue;
        }

        // Kalman filter prediction & update
        const Q = 0.0000001 * Math.min(dt, 30);
        const predPLat = filterPLat + Q;
        const predPLng = filterPLng + Q;
        const kLat = predPLat / (predPLat + R);
        const kLng = predPLng / (predPLng + R);
        filterLat = filterLat + kLat * (lat - filterLat);
        filterLng = filterLng + kLng * (lng - filterLng);
        filterPLat = (1 - kLat) * predPLat;
        filterPLng = (1 - kLng) * predPLng;

        const dRawKm = prevValid ? haversineDistance({ lat: prevValid.latRaw ?? prevValid.lat, lng: prevValid.lngRaw ?? prevValid.lng }, { lat, lng }) : 0;
        const distM = dRawKm * 1000;
        const reportedSpeedKmh = (Number(pt.speed) || 0) * 3.6;
        const rawCalcSpeedKmh = dt > 0 ? (dRawKm / dt) * 3600 : 0;
        const effectiveSpeedKmh = reportedSpeedKmh > 0 ? Math.max(reportedSpeedKmh, rawCalcSpeedKmh) : rawCalcSpeedKmh;

        const distFromCentroidM = haversineDistance({ lat: centroidLat, lng: centroidLng }, { lat, lng }) * 1000;
        const isPoorAccuracy = accuracy > 120;
        const isInsideCentroidGeofence = distFromCentroidM < 45.0 && (effectiveSpeedKmh < 3.5 || reportedSpeedKmh < 1.0);
        const isStationaryDrift = isPoorAccuracy || isInsideCentroidGeofence || (distM < 5.0) || (distM < 12.0 && effectiveSpeedKmh < 2.2);
        const isTeleportation = effectiveSpeedKmh > 180.0;
        const isMathematicallyValidMovement = !isStationaryDrift && !isTeleportation && dRawKm > 0 && dt <= 1800;

        if (isMathematicallyValidMovement) {
          if (!existingToEventIds.has(eventId)) {
            const safeFromEventId = lastEventId || `${sessionId}:start`;
            newLedgerSegments.push({
              organizationId: session.organizationId,
              employee: session.employee?._id || session.employee,
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
              reason: 'AGTRIE_X_V7_CENTROID_GEODESIC_ACCEPTED',
              algorithmVersion: 'AGTRIE-X-v7.0-PRO'
            });
          }

          centroidLat = lat;
          centroidLng = lng;
          prev2Valid = prevValid;
          prevValid = {
            lat: filterLat,
            lng: filterLng,
            latRaw: lat,
            lngRaw: lng,
            accuracy,
            speedKmh: reportedSpeedKmh,
            timestamp: timestamp.toISOString(),
            heading: pt.heading
          };
          lastValidLat = filterLat;
          lastValidLng = filterLng;
          lastEventId = eventId;
          prevTimestamp = tMs;
        } else if (isStationaryDrift) {
          centroidLat = centroidLat * 0.95 + lat * 0.05;
          centroidLng = centroidLng * 0.95 + lng * 0.05;
          lastValidLat = filterLat;
          lastValidLng = filterLng;
          lastEventId = eventId;
          prevTimestamp = tMs;
        }
      }

      if (newLedgerSegments.length > 0) {
        console.log(`  ➕ Inserting ${newLedgerSegments.length} missing DistanceLedger segments...`);
        await DistanceLedger.insertMany(newLedgerSegments, { ordered: false }).catch((e) => console.log(`  Note: ${e.message}`));
      }

      // Aggregate final official total from DistanceLedger
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      const officialKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
      console.log(`  ✅ Authoritative Distance for ${empName}: ${officialKm} KM (Previous Session KM: ${session.totalDistance || 0} KM)`);

      // Update LiveLocation & Attendance
      await LiveLocation.updateOne(
        { _id: session._id },
        {
          $set: {
            totalDistance: officialKm,
            officialDistance: officialKm,
            acceptedDistance: officialKm,
            lastActivity: new Date()
          }
        }
      );

      const sessionDate = session.date || today;
      await Attendance.updateOne(
        { employee: session.employee?._id || session.employee, date: sessionDate },
        { $set: { totalDistanceTraveled: officialKm } }
      );

      await saveSessionState(sessionId, {
        totalDistance: officialKm,
        lastLat: lastValidLat,
        lastLng: lastValidLng,
        lastTs: new Date().toISOString()
      });
    }

    console.log('\n🎉 ALL EMPLOYEE REPROCESSING & KM RECOVERY COMPLETED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during reprocessing:', err);
    process.exit(1);
  }
}

reprocessAllEmployeesToday();
