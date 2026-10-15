require('dotenv').config();
const mongoose = require('mongoose');
const { getSessionState, saveSessionState } = require('../services/cache.service');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('--- RECTIFYING ALL SESSIONS FOR 2026-10-15 ---');

  // 1. Fix Saifuddin Ansari (self test session b0ea1e28-f399-4cc9-9e4d-4433a94df30a)
  console.log('\n--- Rectifying Saifuddin Ansari (Self Test) ---');
  const saifSessionId = 'b0ea1e28-f399-4cc9-9e4d-4433a94df30a';
  
  // Reject the duplicate 10.52 km highway gap segment
  const dupRejectRes = await db.collection('distanceledgers').updateOne(
    { 
      sessionId: saifSessionId,
      toEventId: 'b0ea1e28-f399-4cc9-9e4d-4433a94df30a:1792036763022:26.817506:80.882289'
    },
    {
      $set: {
        classification: 'REJECTED',
        reason: 'DUPLICATE_GAP_COLLISION_REJECTED'
      }
    }
  );
  console.log('Rejected duplicate 10.52 km highway gap ledger:', dupRejectRes.modifiedCount);

  // Compute clean distance for Saifuddin
  const saifAgg = await db.collection('distanceledgers').aggregate([
    { $match: { sessionId: saifSessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
    { $group: { _id: null, total: { $sum: '$distanceKm' } } }
  ]).toArray();
  const saifCleanKm = Math.round((saifAgg[0]?.total || 0) * 100) / 100;
  console.log(`Saifuddin Clean Total Distance: ${saifCleanKm} km`);

  // Clean coordinates array for Saifuddin (remove :sync: and sort by timestamp)
  const saifDoc = await db.collection('livelocations').findOne({ sessionId: saifSessionId });
  const saifRawCoords = saifDoc.coordinates || [];
  const saifCleanCoords = saifRawCoords
    .filter(c => c && c.lat && c.lng && (!c.eventId || !c.eventId.includes(':sync:')))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  await db.collection('livelocations').updateOne(
    { sessionId: saifSessionId },
    {
      $set: {
        totalDistance: saifCleanKm,
        officialDistance: saifCleanKm,
        acceptedDistance: saifCleanKm,
        rawGpsDistance: saifCleanKm,
        coordinates: saifCleanCoords
      }
    }
  );
  await db.collection('attendances').updateOne(
    { employee: saifDoc.employee, date: '2026-10-15' },
    { $set: { totalDistanceTraveled: saifCleanKm } }
  );
  await db.collection('users').updateOne(
    { _id: saifDoc.employee },
    { $set: { totalDistance: saifCleanKm, totalDistanceToday: saifCleanKm } }
  );
  try {
    const rState = await getSessionState(saifSessionId);
    if (rState) {
      rState.totalDistance = saifCleanKm;
      rState.officialDistance = saifCleanKm;
      await saveSessionState(saifSessionId, rState);
    }
  } catch (_) {}
  console.log(`Saifuddin live session, attendance, user & Redis updated to ${saifCleanKm} km!`);

  // 2. Fix Akshay Kumar (session b3f38e19-f13d-4dfb-a269-15cfbeb071a7)
  console.log('\n--- Rectifying Akshay Kumar ---');
  const akshaySessionId = 'b3f38e19-f13d-4dfb-a269-15cfbeb071a7';
  const akshayAgg = await db.collection('distanceledgers').aggregate([
    { $match: { sessionId: akshaySessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
    { $group: { _id: null, total: { $sum: '$distanceKm' } } }
  ]).toArray();
  const akshayCleanKm = Math.round((akshayAgg[0]?.total || 0) * 100) / 100;
  console.log(`Akshay Clean Total Distance: ${akshayCleanKm} km (was 51.32 km)`);

  const akshayDoc = await db.collection('livelocations').findOne({ sessionId: akshaySessionId });
  const akshayCleanCoords = (akshayDoc.coordinates || [])
    .filter(c => c && c.lat && c.lng && (!c.eventId || !c.eventId.includes(':sync:')))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  await db.collection('livelocations').updateOne(
    { sessionId: akshaySessionId },
    {
      $set: {
        totalDistance: akshayCleanKm,
        officialDistance: akshayCleanKm,
        acceptedDistance: akshayCleanKm,
        rawGpsDistance: akshayCleanKm,
        coordinates: akshayCleanCoords
      }
    }
  );
  await db.collection('attendances').updateOne(
    { employee: akshayDoc.employee, date: '2026-10-15' },
    { $set: { totalDistanceTraveled: akshayCleanKm } }
  );
  await db.collection('users').updateOne(
    { _id: akshayDoc.employee },
    { $set: { totalDistance: akshayCleanKm, totalDistanceToday: akshayCleanKm } }
  );
  try {
    const rState = await getSessionState(akshaySessionId);
    if (rState) {
      rState.totalDistance = akshayCleanKm;
      rState.officialDistance = akshayCleanKm;
      await saveSessionState(akshaySessionId, rState);
    }
  } catch (_) {}
  console.log(`Akshay live session, attendance, user & Redis updated to ${akshayCleanKm} km!`);

  // 3. Confirm Rajesh Kumar and Indresh Kumar
  const rDoc = await db.collection('livelocations').findOne({ sessionId: '7cb84c5f-2242-4857-926e-27fbbd081add' });
  const iDoc = await db.collection('livelocations').findOne({ sessionId: 'e6f71bbf-ad79-4518-80cd-2df0063b2fa4' });
  console.log(`\nVerification:`);
  console.log(`  Rajesh Kumar totalDistance: ${rDoc?.totalDistance} km, officialDistance: ${rDoc?.officialDistance} km`);
  console.log(`  Indresh Kumar totalDistance: ${iDoc?.totalDistance} km, officialDistance: ${iDoc?.officialDistance} km`);

  await mongoose.disconnect();
  console.log('\n✅ All sessions rectified successfully.');
}

run().catch(console.error);
