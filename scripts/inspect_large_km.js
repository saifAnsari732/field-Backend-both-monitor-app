require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const today = '2026-10-15';
  console.log('Today:', today);

  const users = await db.collection('users').find({
    $or: [
      { name: /indresh/i },
      { name: /rajesh/i },
      { employeeId: /1532/i }
    ]
  }).toArray();

  console.log('Found users:', users.map(u => ({ id: u._id, name: u.name, employeeId: u.employeeId, role: u.role })));

  for (const user of users) {
    console.log(`\n=================== USER: ${user.name} (${user.employeeId}) ===================`);
    const sessions = await db.collection('livelocations').find({
      employee: user._id,
      date: today
    }).toArray();

    console.log('Session count:', sessions.length);
    for (const s of sessions) {
      console.log('Session ID:', s.sessionId, 'isActive:', s.isActive, 'totalDistance:', s.totalDistance, 'officialDistance:', s.officialDistance, 'acceptedDistance:', s.acceptedDistance, 'rawGpsDistance:', s.rawGpsDistance, 'manualDistanceAdded:', s.manualDistanceAdded);
      console.log('Coords count:', s.coordinates ? s.coordinates.length : 0);
      console.log('Start time:', s.startTime, 'Last activity:', s.lastActivity);

      if (s.coordinates && s.coordinates.length > 0) {
        console.log('First 5 coords:');
        s.coordinates.slice(0, 5).forEach((c, i) => console.log(`  [${i}] ${c.timestamp} | Lat: ${c.lat}, Lng: ${c.lng} | Speed: ${c.speed} | Acc: ${c.accuracy} | Addr: ${c.address}`));

        console.log('\nChecking for oscillations / large jumps:');
        for (let i = 1; i < Math.min(s.coordinates.length, 30); i++) {
          const c1 = s.coordinates[i - 1];
          const c2 = s.coordinates[i];
          const dLat = Math.abs(c2.lat - c1.lat);
          const dLng = Math.abs(c2.lng - c1.lng);
          const approxDistKm = Math.hypot(dLat, dLng) * 111;
          if (approxDistKm > 0.5) {
            console.log(`  Jump [${i-1} -> ${i}]: ${approxDistKm.toFixed(2)} km in ${((new Date(c2.timestamp) - new Date(c1.timestamp))/1000).toFixed(0)}s | (${c1.lat.toFixed(4)}, ${c1.lng.toFixed(4)}) -> (${c2.lat.toFixed(4)}, ${c2.lng.toFixed(4)})`);
          }
        }

        console.log('\nLast 5 coords:');
        s.coordinates.slice(-5).forEach((c, i) => console.log(`  [-${5-i}] ${c.timestamp} | Lat: ${c.lat}, Lng: ${c.lng} | Speed: ${c.speed} | Acc: ${c.accuracy}`));
      }

      // Check DistanceLedger segments for this session
      const ledgerCount = await db.collection('distanceledgers').countDocuments({ sessionId: s.sessionId });
      console.log('DistanceLedger count:', ledgerCount);

      const topSegments = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).sort({ distanceKm: -1 }).limit(10).toArray();
      console.log('Top 10 largest distance segments in ledger:');
      topSegments.forEach(seg => {
        console.log(`  ${seg.classification} | ${seg.distanceKm} km (${seg.distanceMeters}m) | Reason: ${seg.reason} | (${seg.fromLat}, ${seg.fromLng}) -> (${seg.toLat}, ${seg.toLng}) | from: ${seg.fromTimestamp} to: ${seg.toTimestamp}`);
      });

      // Aggregate by reason
      const aggByReason = await db.collection('distanceledgers').aggregate([
        { $match: { sessionId: s.sessionId } },
        { $group: { _id: '$reason', totalKm: { $sum: '$distanceKm' }, count: { $sum: 1 } } }
      ]).toArray();
      console.log('Ledger summary by reason:', aggByReason);
    }
  }

  await mongoose.disconnect();
}

check().catch(console.error);
