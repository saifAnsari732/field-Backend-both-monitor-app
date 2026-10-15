require('dotenv').config();
const mongoose = require('mongoose');

async function testClean() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const today = '2026-10-15';
  const sessions = await db.collection('livelocations').find({
    date: today,
    totalDistance: { $gt: 100 }
  }).toArray();

  for (const s of sessions) {
    const user = await db.collection('users').findOne({ _id: s.employee });
    console.log(`\nEmployee: ${user?.name} (${user?.employeeId}), Current Total in DB: ${s.totalDistance} km`);

    // Sum of only legitimate road segments
    const legitimateAgg = await db.collection('distanceledgers').aggregate([
      { 
        $match: { 
          sessionId: s.sessionId, 
          classification: { $in: ['ACCEPTED', 'RECOVERED'] },
          reason: { $ne: 'POINT_A_TO_POINT_B_ROAD_DISTANCE_ACCEPTED' }
        } 
      },
      { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
    ]).toArray();

    const legitimateKm = Math.round((legitimateAgg[0]?.totalKm || 0) * 100) / 100;
    console.log(`  Legitimate KM (excluding bogus Point A to B jumps): ${legitimateKm} km`);
  }

  await mongoose.disconnect();
}
testClean().catch(console.error);
