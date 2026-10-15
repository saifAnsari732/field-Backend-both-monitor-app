require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const s = await db.collection('livelocations').findOne({ sessionId: 'b3f38e19-f13d-4dfb-a269-15cfbeb071a7' });
  const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
  console.log('Total distance in DB:', s.totalDistance, 'Official:', s.officialDistance);
  console.log('Total coordinates:', s.coordinates?.length);
  console.log('Ledgers count:', ledgers.length);
  for (const l of ledgers) {
    console.log(`[${l.classification}] ${l.reason} | ${l.distanceKm} km | from: (${l.fromLat}, ${l.fromLng}) at ${l.fromTimestamp} -> to: (${l.toLat}, ${l.toLng}) at ${l.toTimestamp} | fromEvent: ${l.fromEventId} -> toEvent: ${l.toEventId}`);
  }
  await mongoose.disconnect();
}
run().catch(console.error);
