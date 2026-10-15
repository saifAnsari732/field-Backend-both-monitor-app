require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const s = await db.collection('livelocations').findOne({ sessionId: 'b0ea1e28-f399-4cc9-9e4d-4433a94df30a' });
  const user = await db.collection('users').findOne({ _id: s.employee });
  console.log('Employee:', user?.name, user?.employeeId, user?.phone);
  console.log('Total distance:', s.totalDistance, 'Official:', s.officialDistance);

  const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
  for (const l of ledgers) {
    if (l.reason === 'POINT_A_TO_POINT_B_ROAD_DISTANCE_ACCEPTED' || l.distanceKm > 1.0) {
      console.log(`[${l.classification}] ${l.reason} | ${l.distanceKm} km | from: (${l.fromLat}, ${l.fromLng}) at ${l.fromTimestamp} -> to: (${l.toLat}, ${l.toLng}) at ${l.toTimestamp} | fromEvent: ${l.fromEventId} -> toEvent: ${l.toEventId}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
