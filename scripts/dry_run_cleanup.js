require('dotenv').config();
const mongoose = require('mongoose');

async function dryRun() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const sessions = await db.collection('livelocations').find({ date: '2026-10-15' }).toArray();

  for (const s of sessions) {
    const user = await db.collection('users').findOne({ _id: s.employee });
    const rawCoords = s.coordinates || [];

    // Filter out :sync: coordinates
    const filteredCoords = rawCoords.filter(c => !c.eventId || !c.eventId.includes(':sync:'));

    // Check ledgers
    const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
    let legitKm = 0;
    let bogusKm = 0;
    let bogusCount = 0;

    for (const l of ledgers) {
      const isBogus = l.reason === 'POINT_A_TO_POINT_B_ROAD_DISTANCE_ACCEPTED' && 
                      (l.toEventId?.includes(':sync:') || l.fromEventId?.includes(':sync:') || l.distanceKm > 5);
      
      if (l.classification === 'ACCEPTED' || l.classification === 'RECOVERED') {
        if (isBogus) {
          bogusKm += (l.distanceKm || 0);
          bogusCount++;
        } else {
          legitKm += (l.distanceKm || 0);
        }
      }
    }

    legitKm = Math.round(legitKm * 100) / 100;
    bogusKm = Math.round(bogusKm * 100) / 100;

    console.log(`\n---------------------------------------------------------`);
    console.log(`EMPLOYEE: ${user?.name} (${user?.employeeId})`);
    console.log(`  Current DB Total: ${s.totalDistance} km`);
    console.log(`  Bogus Jumps Removed: ${bogusCount} segments totaling ${bogusKm} km`);
    console.log(`  Clean Legitimate Distance: ${legitKm} km`);
    console.log(`  Coordinates: ${rawCoords.length} -> Clean: ${filteredCoords.length} (:sync: removed: ${rawCoords.length - filteredCoords.length})`);
  }

  await mongoose.disconnect();
}

dryRun().catch(console.error);
