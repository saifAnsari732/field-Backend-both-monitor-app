require('dotenv').config();
const mongoose = require('mongoose');

async function r() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const pts = await db.collection('distanceledgers').find({ 
    sessionId: 'b0ea1e28-f399-4cc9-9e4d-4433a94df30a'
  }).sort({ toTimestamp: 1 }).toArray();

  console.log('Total distanceledgers for Saifuddin:', pts.length);
  for (const p of pts) {
    if (p.distanceKm > 0.05 || p.classification === 'REJECTED' || p.reason.includes('POINT_A') || p.reason.includes('GAP')) {
      console.log(`[${p.classification}] ${p.reason} | ${p.distanceKm} km | from: (${p.fromLat?.toFixed(5)}, ${p.fromLng?.toFixed(5)}) at ${p.fromTimestamp?.toISOString()} -> to: (${p.toLat?.toFixed(5)}, ${p.toLng?.toFixed(5)}) at ${p.toTimestamp?.toISOString()} | fromEvent: ${p.fromEventId} -> toEvent: ${p.toEventId}`);
    }
  }
  await mongoose.disconnect();
}
r().catch(console.error);
