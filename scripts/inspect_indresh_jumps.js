require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const session = await db.collection('livelocations').findOne({
    sessionId: 'e6f71bbf-ad79-4518-80cd-2df0063b2fa4'
  });

  console.log('Total coordinates:', session.coordinates.length);
  // Find all coordinates between 09:20 and 10:25
  const interesting = session.coordinates.filter(c => {
    const d = new Date(c.timestamp);
    const hrs = d.getUTCHours() + 5.5; // IST approx
    return true;
  });

  // Print segments where distance from previous is > 1km
  for (let i = 1; i < session.coordinates.length; i++) {
    const c1 = session.coordinates[i-1];
    const c2 = session.coordinates[i];
    const dLat = Math.abs(c2.lat - c1.lat);
    const dLng = Math.abs(c2.lng - c1.lng);
    const dKm = Math.hypot(dLat, dLng) * 111;
    if (dKm > 2.0) {
      console.log(`[${i-1} -> ${i}] ${c1.timestamp} -> ${c2.timestamp} | ${dKm.toFixed(2)} km | (${c1.lat}, ${c1.lng}) [acc:${c1.accuracy}, spd:${c1.speed}, addr:${c1.address}] -> (${c2.lat}, ${c2.lng}) [acc:${c2.accuracy}, spd:${c2.speed}, addr:${c2.address}] eventId:${c2.eventId}`);
    }
  }

  await mongoose.disconnect();
}
check().catch(console.error);
