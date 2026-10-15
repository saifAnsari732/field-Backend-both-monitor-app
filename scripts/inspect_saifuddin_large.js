require('dotenv').config();
const mongoose = require('mongoose');
async function r() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const pts = await db.collection('distanceledgers').find({ 
    sessionId: 'b0ea1e28-f399-4cc9-9e4d-4433a94df30a',
    distanceKm: { $gt: 0.5 }
  }).toArray();
  for (const p of pts) {
    console.log(p.classification, p.reason, p.distanceKm, 'km | from:', p.fromTimestamp, 'to:', p.toTimestamp, '| fromEvent:', p.fromEventId, '-> toEvent:', p.toEventId);
  }
  await mongoose.disconnect();
}
r();
