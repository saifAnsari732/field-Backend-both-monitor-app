require('dotenv').config();
const mongoose = require('mongoose');

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function inspectDetails() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({
    $or: [
      { employeeId: 'EMP-6FD8C90E' },
      { name: { $regex: 'Indresh', $options: 'i' } }
    ]
  }).toArray();

  for (const u of users) {
    console.log(`\n========================================`);
    console.log(`ANALYSIS FOR: ${u.name} (${u.employeeId})`);

    const sessions = await db.collection('livelocations').find({
      employee: u._id,
      date: '2026-10-15'
    }).toArray();

    for (const s of sessions) {
      console.log(`\nSession ${s.sessionId}:`);
      console.log(`Current DB totalDistance: ${s.totalDistance}, officialDistance: ${s.officialDistance}`);
      
      const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
      let syncLedgers = 0;
      let supersonicLedgers = 0;
      let acceptedLedgers = 0;
      let recoveredLedgers = 0;
      let rejectedLedgers = 0;
      let sumClean = 0;
      let sumRejected = 0;

      for (const l of ledgers) {
        const isSync = (l.toEventId && l.toEventId.includes(':sync:')) || (l.fromEventId && l.fromEventId.includes(':sync:'));
        const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
        const speedKmh = (l.distanceKm / (dtSec / 3600));
        const isSupersonic = speedKmh > 150 && l.distanceKm > 1.5;

        if (isSync) syncLedgers++;
        if (isSupersonic) supersonicLedgers++;

        const willBeRejected = isSync || isSupersonic || l.classification === 'REJECTED';

        if (!willBeRejected && (l.classification === 'ACCEPTED' || l.classification === 'RECOVERED')) {
          if (l.classification === 'ACCEPTED') acceptedLedgers++;
          if (l.classification === 'RECOVERED') recoveredLedgers++;
          sumClean += l.distanceKm;
        } else {
          rejectedLedgers++;
          sumRejected += l.distanceKm;
        }
      }

      console.log(`Ledgers count: ${ledgers.length}`);
      console.log(`  Sync ledgers: ${syncLedgers}, Supersonic ledgers: ${supersonicLedgers}`);
      console.log(`  Clean accepted ledgers: ${acceptedLedgers}, recovered: ${recoveredLedgers}`);
      console.log(`  Clean sum distance: ${sumClean.toFixed(3)} km (${(Math.round(sumClean * 100) / 100)} km)`);
      console.log(`  Rejected sum distance: ${sumRejected.toFixed(3)} km`);

      // Analyze coordinates
      const coords = s.coordinates || [];
      console.log(`\nCoordinates count: ${coords.length}`);
      
      let syncCoords = 0;
      let coordSupersonicJumps = 0;
      const cleanCoords = [];

      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        const isSync = c.eventId && c.eventId.includes(':sync:');
        if (isSync) {
          syncCoords++;
          continue;
        }

        // Check jump from previous clean coord
        if (cleanCoords.length > 0) {
          const prev = cleanCoords[cleanCoords.length - 1];
          const distKm = haversineDistanceKm(prev.lat, prev.lng, c.lat, c.lng);
          const dtSec = Math.max((new Date(c.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000, 1);
          const speedKmh = distKm / (dtSec / 3600);
          if (speedKmh > 150 && distKm > 1.5) {
            coordSupersonicJumps++;
            console.log(`  Supersonic jump dropped at index ${i}: dist=${distKm.toFixed(2)} km, dt=${dtSec}s, speed=${speedKmh.toFixed(1)} km/h`);
            continue;
          }
        }
        cleanCoords.push(c);
      }

      console.log(`  Sync coords found: ${syncCoords}`);
      console.log(`  Supersonic jumps found: ${coordSupersonicJumps}`);
      console.log(`  Clean coords remaining: ${cleanCoords.length}`);
      if (cleanCoords.length > 0) {
        const last = cleanCoords[cleanCoords.length - 1];
        console.log(`  Last clean coord: lat=${last.lat}, lng=${last.lng}, ts=${last.timestamp}, eventId=${last.eventId}`);
      }
    }
  }

  await mongoose.disconnect();
}

inspectDetails().catch(console.error);
