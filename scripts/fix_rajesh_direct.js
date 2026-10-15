require('dotenv').config();
const mongoose = require('mongoose');
const { getSessionState, saveSessionState } = require('../services/cache.service');

async function fixRajesh() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const user = await db.collection('users').findOne({ employeeId: 'EMP-6FD8C90E' });
  console.log('User:', user?.name, user?._id);

  const activeSessions = await db.collection('livelocations').find({
    employee: user._id,
    date: '2026-10-15'
  }).toArray();

  console.log('Found sessions for Rajesh:', activeSessions.length);

  for (const s of activeSessions) {
    console.log(`\nSession ${s.sessionId} current totalDistance: ${s.totalDistance} km`);

    // 1. Mark all bogus :sync: and supersonic jumps in distanceledgers as REJECTED
    const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
    let bogusCount = 0;
    let bogusKm = 0;

    for (const l of ledgers) {
      const isSync = l.toEventId?.includes(':sync:') || l.fromEventId?.includes(':sync:');
      const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
      const speedKmh = (l.distanceKm / (dtSec / 3600));
      const isSupersonic = speedKmh > 150.0 && l.distanceKm > 1.5;

      if ((isSync || isSupersonic) && l.classification !== 'REJECTED') {
        bogusCount++;
        bogusKm += l.distanceKm;
        await db.collection('distanceledgers').updateOne(
          { _id: l._id },
          { $set: { classification: 'REJECTED', reason: 'BOGUS_JUMP_REJECTED' } }
        );
      }
    }

    // 2. Sum only legitimate accepted & recovered ledgers
    const cleanAgg = await db.collection('distanceledgers').aggregate([
      { $match: { sessionId: s.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
      { $group: { _id: null, total: { $sum: '$distanceKm' } } }
    ]).toArray();

    const cleanKm = Math.round((cleanAgg[0]?.total || 0) * 100) / 100;

    // 3. Purge :sync: coordinates from coordinates array
    const rawCoords = s.coordinates || [];
    const cleanCoords = rawCoords.filter(c => !c.eventId || !c.eventId.includes(':sync:'));

    // 4. Update MongoDB LiveLocation
    const updateRes = await db.collection('livelocations').updateOne(
      { _id: s._id },
      {
        $set: {
          totalDistance: cleanKm,
          officialDistance: cleanKm,
          acceptedDistance: cleanKm,
          rawGpsDistance: cleanKm,
          coordinates: cleanCoords
        }
      }
    );

    // 5. Update Attendance
    await db.collection('attendances').updateOne(
      { employee: user._id, date: '2026-10-15' },
      { $set: { totalDistanceTraveled: cleanKm } }
    );

    // 6. Update Redis cache if available
    try {
      const redisState = await getSessionState(s.sessionId);
      if (redisState) {
        redisState.totalDistance = cleanKm;
        redisState.officialDistance = cleanKm;
        await saveSessionState(s.sessionId, redisState);
        console.log('  Updated Redis cache to:', cleanKm);
      }
    } catch (e) {
      console.log('  Redis update note:', e.message);
    }

    console.log('✅ Cleaned Rajesh Session:');
    console.log('  Bogus ledgers rejected:', bogusCount, 'totaling', bogusKm.toFixed(2), 'km');
    console.log('  New Total Distance in DB:', cleanKm, 'km (updated:', updateRes.modifiedCount, ')');
    console.log('  Coordinates count:', rawCoords.length, '->', cleanCoords.length);
  }

  // Also check if there are other sessions today for Rajesh in livelocations
  const allRajeshSessions = await db.collection('livelocations').find({ employee: user._id, date: '2026-10-15' }).toArray();
  for (const rs of allRajeshSessions) {
    console.log(`Verification: sessionId ${rs.sessionId} -> totalDistance is now: ${rs.totalDistance} km`);
  }

  await mongoose.disconnect();
}

fixRajesh().catch(console.error);
