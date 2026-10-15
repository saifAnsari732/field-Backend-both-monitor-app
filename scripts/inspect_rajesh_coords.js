require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const s = await db.collection('livelocations').findOne({ sessionId: '7cb84c5f-2242-4857-926e-27fbbd081add' });
  const coords = s.coordinates || [];
  console.log('Total coords:', coords.length);

  for (let i = 1; i < coords.length; i++) {
    const c1 = coords[i-1];
    const c2 = coords[i];
    const dLat = Math.abs(c2.lat - c1.lat);
    const dLng = Math.abs(c2.lng - c1.lng);
    const dKm = Math.hypot(dLat, dLng) * 111;
    if (dKm > 1.0) {
      console.log(`[${i-1}->${i}] ${dKm.toFixed(2)}km | (${c1.lat.toFixed(5)}, ${c1.lng.toFixed(5)}) -> (${c2.lat.toFixed(5)}, ${c2.lng.toFixed(5)}) | id1: ${c1.eventId} -> id2: ${c2.eventId}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(console.error);
