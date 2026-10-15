require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const s = await db.collection('livelocations').findOne({ sessionId: 'b3f38e19-f13d-4dfb-a269-15cfbeb071a7' });
  const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).sort({ toTimestamp: 1 }).toArray();

  console.log('Session totalDistance:', s.totalDistance, 'official:', s.officialDistance);
  console.log('Ledgers count:', ledgers.length);

  let runningSum = 0;
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    runningSum += (l.distanceKm || 0);
    console.log(`[#${i+1}] ${l.classification} | ${l.reason} | ${l.distanceKm} km (running: ${runningSum.toFixed(2)}) | (${l.fromLat?.toFixed(5)}, ${l.fromLng?.toFixed(5)}) -> (${l.toLat?.toFixed(5)}, ${l.toLng?.toFixed(5)}) | ${l.fromTimestamp?.toISOString()?.substring(11, 19)} -> ${l.toTimestamp?.toISOString()?.substring(11, 19)} | event: ${l.toEventId}`);
  }

  // Also check all coordinates
  const coords = s.coordinates || [];
  console.log('\n--- Coordinates analysis ---');
  console.log('Total coordinates:', coords.length);
  for (let i = 1; i < coords.length; i++) {
    const c1 = coords[i-1];
    const c2 = coords[i];
    const dLat = Math.abs(c2.lat - c1.lat);
    const dLng = Math.abs(c2.lng - c1.lng);
    const dKm = Math.hypot(dLat, dLng) * 111;
    if (dKm > 0.5) {
      console.log(`Jump coord [${i-1}->${i}] ${dKm.toFixed(2)} km | (${c1.lat?.toFixed(5)}, ${c1.lng?.toFixed(5)}) -> (${c2.lat?.toFixed(5)}, ${c2.lng?.toFixed(5)}) | id1: ${c1.eventId} -> id2: ${c2.eventId}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
