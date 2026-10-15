require('dotenv').config();
const mongoose = require('mongoose');

async function checkAkshay() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const s = await db.collection('livelocations').findOne({ sessionId: 'b3f38e19-f13d-4dfb-a269-15cfbeb071a7' });
  const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).sort({ toTimestamp: 1 }).toArray();

  let legitKm = 0;
  let rejectedKm = 0;

  for (const l of ledgers) {
    const isSync = l.toEventId?.includes(':sync:') || l.fromEventId?.includes(':sync:');
    const isBigJump = l.distanceKm > 2.5 && l.reason === 'POINT_A_TO_POINT_B_ROAD_DISTANCE_ACCEPTED';
    if (isSync || isBigJump) {
      console.log(`[BOGUS] ${l.distanceKm} km | reason: ${l.reason} | ${l.fromEventId} -> ${l.toEventId}`);
      rejectedKm += l.distanceKm;
    } else {
      legitKm += l.distanceKm;
    }
  }

  console.log(`\nAkshay Kumar:`);
  console.log(`  Current in DB: ${s.totalDistance} km`);
  console.log(`  Bogus removed: ${rejectedKm.toFixed(2)} km`);
  console.log(`  Real Legit Road KM: ${legitKm.toFixed(2)} km`);

  await mongoose.disconnect();
}

checkAkshay().catch(console.error);
