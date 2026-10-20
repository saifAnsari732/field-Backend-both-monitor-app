require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, DistanceLedger, Attendance, User } = require('../models/index');
  const { saveSessionState, getSessionState, deleteCacheByPrefix } = require('../services/cache.service');

  const sid = '9878cbe7-34ba-476c-afbf-f1fdd6ff69b7';

  // 1. Mark the fake overnight jump segment as REJECTED
  const updatedSegment = await DistanceLedger.findOneAndUpdate(
    { sessionId: sid, distanceKm: { $gt: 100 } },
    {
      $set: {
        classification: 'REJECTED',
        reason: 'AGTRIE_X_LONG_GAP_OVERNIGHT_EXCEEDED_150MIN'
      }
    },
    { new: true }
  );

  console.log('Updated large segment:', updatedSegment ? {
    km: updatedSegment.distanceKm,
    class: updatedSegment.classification,
    reason: updatedSegment.reason
  } : 'Not found');

  // 2. Sum remaining valid distance
  const validSegments = await DistanceLedger.find({
    sessionId: sid,
    classification: { $in: ['ACCEPTED', 'RECOVERED'] }
  });

  let cleanKm = 0;
  for (const s of validSegments) {
    cleanKm += Number(s.distanceKm) || 0;
  }
  cleanKm = Math.round(cleanKm * 100) / 100;
  console.log(`Clean legitimate KM for Indresh: ${cleanKm} km (from ${validSegments.length} valid segments)`);

  // 3. Update LiveLocation
  const updatedLive = await LiveLocation.findOneAndUpdate(
    { sessionId: sid },
    {
      $set: {
        totalDistance: cleanKm,
        officialDistance: cleanKm,
        acceptedDistance: cleanKm,
        rawGpsDistance: cleanKm,
        unverifiedDistance: 141.80
      }
    },
    { new: true }
  );
  console.log('Updated LiveLocation:', {
    sessionId: updatedLive.sessionId,
    totalDistance: updatedLive.totalDistance,
    officialDistance: updatedLive.officialDistance
  });

  // 4. Update Attendance
  if (updatedLive.employee) {
    await Attendance.findOneAndUpdate(
      { employee: updatedLive.employee, date: updatedLive.date },
      { $set: { totalDistanceTraveled: cleanKm } }
    );
    console.log('Updated Attendance to:', cleanKm);

    await User.findByIdAndUpdate(updatedLive.employee, {
      totalDistanceToday: cleanKm
    });
    console.log('Updated User totalDistanceToday to:', cleanKm);
  }

  // 5. Update Redis
  const state = await getSessionState(sid);
  if (state) {
    await saveSessionState(sid, {
      ...state,
      totalDistance: cleanKm,
      officialDistance: cleanKm
    });
    console.log('Updated Redis session state to:', cleanKm);
  }

  // Invalidate caches
  await deleteCacheByPrefix('live_locations_');
  await deleteCacheByPrefix('admin_employees_');
  await deleteCacheByPrefix('admin_dashboard_stats_');
  console.log('Caches cleared.');

  console.log('✅ RECTIFICATION COMPLETE!');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
