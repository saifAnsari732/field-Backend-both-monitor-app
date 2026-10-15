require('dotenv').config();
const mongoose = require('mongoose');

async function checkScreenDist() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const sessions = await db.collection('livelocations').find({
    sessionId: { $in: ['7cb84c5f-2242-4857-926e-27fbbd081add', 'e6f71bbf-ad79-4518-80cd-2df0063b2fa4'] }
  }).toArray();
  for (const s of sessions) {
    const coordsWithScreenDist = (s.coordinates || []).filter(c => c.screenDistanceKm !== undefined && c.screenDistanceKm !== null && c.screenDistanceKm > 0);
    console.log(`Session ${s.sessionId}: ${coordsWithScreenDist.length} coords have screenDistanceKm`);
    if (coordsWithScreenDist.length > 0) {
      console.log('Sample screenDistanceKm:', coordsWithScreenDist.slice(0, 3).map(c => c.screenDistanceKm));
    }
  }
  await mongoose.disconnect();
}
checkScreenDist().catch(console.error);
