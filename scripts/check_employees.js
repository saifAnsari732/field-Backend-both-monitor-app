require('dotenv').config();
const mongoose = require('mongoose');
const { getSessionState } = require('../services/cache.service');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({
    $or: [
      { employeeId: 'EMP-6FD8C90E' },
      { name: { $regex: 'Rajesh', $options: 'i' } },
      { name: { $regex: 'Indresh', $options: 'i' } }
    ]
  }).toArray();

  console.log('--- USERS ---');
  console.log(users.map(u => ({
    _id: u._id,
    name: u.name,
    employeeId: u.employeeId,
    totalDistance: u.totalDistance,
    totalDistanceToday: u.totalDistanceToday,
    isTracking: u.isTracking
  })));

  for (const u of users) {
    console.log(`\n========================================`);
    console.log(`Employee: ${u.name} (${u.employeeId}, _id: ${u._id})`);

    const sessions = await db.collection('livelocations').find({
      employee: u._id,
      date: '2026-10-15'
    }).toArray();

    console.log(`Found ${sessions.length} livelocation session(s) for 2026-10-15:`);

    for (const s of sessions) {
      console.log(`\n  SessionId: ${s.sessionId}`);
      console.log(`  isActive: ${s.isActive}, totalDistance: ${s.totalDistance}, officialDistance: ${s.officialDistance}`);
      console.log(`  acceptedDistance: ${s.acceptedDistance}, rawGpsDistance: ${s.rawGpsDistance}`);
      console.log(`  coordinates count: ${s.coordinates?.length || 0}`);

      // Count sync coords
      const syncCoords = (s.coordinates || []).filter(c => c.eventId && c.eventId.includes(':sync:'));
      console.log(`  sync coordinates in array: ${syncCoords.length}`);

      // Check distanceledgers
      const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
      const statusCounts = {};
      let syncLedgers = 0;
      let acceptedKm = 0;
      let recoveredKm = 0;
      let rejectedKm = 0;
      let supersonicLedgers = 0;

      for (const l of ledgers) {
        statusCounts[l.classification] = (statusCounts[l.classification] || 0) + 1;
        const isSync = (l.toEventId && l.toEventId.includes(':sync:')) || (l.fromEventId && l.fromEventId.includes(':sync:'));
        if (isSync) syncLedgers++;
        const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
        const speedKmh = (l.distanceKm / (dtSec / 3600));
        if (speedKmh > 150 && l.distanceKm > 1.5) supersonicLedgers++;

        if (l.classification === 'ACCEPTED') acceptedKm += (l.distanceKm || 0);
        else if (l.classification === 'RECOVERED') recoveredKm += (l.distanceKm || 0);
        else if (l.classification === 'REJECTED') rejectedKm += (l.distanceKm || 0);
      }

      console.log(`  DistanceLedgers total: ${ledgers.length}`);
      console.log(`  Classifications:`, statusCounts);
      console.log(`  Ledgers with :sync:: ${syncLedgers}, supersonic: ${supersonicLedgers}`);
      console.log(`  ACCEPTED Km: ${acceptedKm.toFixed(2)}, RECOVERED Km: ${recoveredKm.toFixed(2)}, REJECTED Km: ${rejectedKm.toFixed(2)}`);
      console.log(`  Clean Total (ACCEPTED + RECOVERED): ${(acceptedKm + recoveredKm).toFixed(2)} km`);

      // Check Redis state
      try {
        const redisState = await getSessionState(s.sessionId);
        console.log(`  Redis session:${s.sessionId} state:`, redisState ? {
          totalDistance: redisState.totalDistance,
          officialDistance: redisState.officialDistance,
          lastLat: redisState.lastLat,
          lastLng: redisState.lastLng,
          lastTs: redisState.lastTs,
          lastEventId: redisState.lastEventId
        } : 'null');
      } catch (e) {
        console.log(`  Redis error:`, e.message);
      }
    }

    const attendances = await db.collection('attendances').find({
      employee: u._id,
      date: '2026-10-15'
    }).toArray();
    console.log(`  Attendances today: ${attendances.length}`);
    for (const a of attendances) {
      console.log(`    _id: ${a._id}, status: ${a.status}, totalDistanceTraveled: ${a.totalDistanceTraveled}`);
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
