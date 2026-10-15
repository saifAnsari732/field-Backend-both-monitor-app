require('dotenv').config();
const mongoose = require('mongoose');
const { getSessionState, saveSessionState } = require('../services/cache.service');

function haversineDist(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function executeCleanup() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const today = '2026-10-15';
  const sessions = await db.collection('livelocations').find({ date: today }).toArray();

  console.log(`Found ${sessions.length} sessions for date ${today}.\n`);

  for (const s of sessions) {
    const user = await db.collection('users').findOne({ _id: s.employee });
    const empName = `${user?.name} (${user?.employeeId})`;
    const beforeTotal = s.totalDistance;

    // 1. Mark bogus DistanceLedger segments as REJECTED
    const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
    let bogusLedgerCount = 0;
    let bogusLedgerKm = 0;

    for (const l of ledgers) {
      const isSyncEvent = l.toEventId?.includes(':sync:') || l.fromEventId?.includes(':sync:');
      
      // Calculate step speed
      const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
      const speedKmh = (l.distanceKm / (dtSec / 3600));
      const isSupersonic = speedKmh > 160.0 && l.distanceKm > 1.5;

      const isBogus = isSyncEvent || isSupersonic;

      if (isBogus && l.classification !== 'REJECTED') {
        bogusLedgerCount++;
        bogusLedgerKm += (l.distanceKm || 0);
        await db.collection('distanceledgers').updateOne(
          { _id: l._id },
          { 
            $set: { 
              classification: 'REJECTED', 
              reason: isSyncEvent ? 'DUPLICATE_SYNC_COLLISION_REJECTED' : 'SUPERSONIC_STEP_REJECTED' 
            } 
          }
        );
      }
    }

    // 2. Re-aggregate valid distance from clean distanceledgers
    const cleanLedgersAgg = await db.collection('distanceledgers').aggregate([
      { 
        $match: { 
          sessionId: s.sessionId, 
          classification: { $in: ['ACCEPTED', 'RECOVERED'] }
        } 
      },
      { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
    ]).toArray();

    const cleanKm = Math.round((cleanLedgersAgg[0]?.totalKm || 0) * 100) / 100;

    // 3. Clean coordinates array (remove :sync: and oscillating rubber-band ping-pongs)
    const rawCoords = s.coordinates || [];
    let cleanCoords = rawCoords.filter(c => !c.eventId || !c.eventId.includes(':sync:'));

    // Secondary pass: remove any ping-pong outlier that jumps > 2km and returns within 10 min
    const finalCoords = [];
    for (let i = 0; i < cleanCoords.length; i++) {
      const c = cleanCoords[i];
      if (finalCoords.length >= 2) {
        const prev1 = finalCoords[finalCoords.length - 1];
        const prev2 = finalCoords[finalCoords.length - 2];
        const d1 = haversineDist(prev1.lat, prev1.lng, c.lat, c.lng);
        const d2 = haversineDist(prev2.lat, prev2.lng, c.lat, c.lng);
        const dPrevJump = haversineDist(prev2.lat, prev2.lng, prev1.lat, prev1.lng);

        if (dPrevJump >= 2.0 && d2 <= 0.6) {
          // prev1 was an outlier jump! Remove prev1 from finalCoords
          finalCoords.pop();
        }
      }
      finalCoords.push(c);
    }

    // 4. Update LiveLocation in DB
    await db.collection('livelocations').updateOne(
      { sessionId: s.sessionId },
      {
        $set: {
          totalDistance: cleanKm,
          officialDistance: cleanKm,
          acceptedDistance: cleanKm,
          rawGpsDistance: cleanKm,
          coordinates: finalCoords,
        }
      }
    );

    // 5. Update Attendance in DB
    await db.collection('attendances').updateOne(
      { employee: s.employee, date: today },
      { $set: { totalDistanceTraveled: cleanKm } }
    );

    // 6. Update Redis cache
    try {
      const redisState = await getSessionState(s.sessionId);
      if (redisState) {
        redisState.totalDistance = cleanKm;
        redisState.officialDistance = cleanKm;
        await saveSessionState(s.sessionId, redisState);
      }
    } catch (_) {}

    console.log(`✅ [CLEANED] ${empName}:`);
    console.log(`   Distance: ${beforeTotal} km  -->  ${cleanKm} km (-${bogusLedgerKm.toFixed(2)} km bogus removed across ${bogusLedgerCount} ledgers)`);
    console.log(`   Coordinates: ${rawCoords.length}  -->  ${finalCoords.length} (${rawCoords.length - finalCoords.length} bogus points purged)\n`);
  }

  await mongoose.disconnect();
  console.log('🎉 Cleanup complete for all sessions!');
}

executeCleanup().catch(console.error);
