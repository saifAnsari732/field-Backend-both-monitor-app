const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function auditHistoricalData() {
  await mongoose.connect(MONGODB_URI);
  console.log('=== DEEP HISTORICAL GPS AUDIT (OCT 3 - OCT 6) ===\n');

  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({
    employee: mongoose.Schema.Types.ObjectId,
    sessionId: String,
    isActive: Boolean,
    coordinates: Array,
    totalDistance: Number,
    date: String,
    startTime: Date,
    endTime: Date
  }), 'livelocations');

  const User = mongoose.model('User', new mongoose.Schema({ name: String }), 'users');
  const DistanceLedger = mongoose.model('DistanceLedger', new mongoose.Schema({
    sessionId: String,
    distanceKm: Number,
    fromTimestamp: Date,
    toTimestamp: Date,
    classification: String,
    speedKmh: Number,
    stepDistanceKm: Number
  }), 'distanceledgers');

  const lalit = await User.findOne({ name: { $regex: /lalit/i } });
  const rajesh = await User.findOne({ name: { $regex: /rajesh/i } });

  const targets = [
    { name: 'Lalit Mishra', user: lalit },
    { name: 'Rajesh Kumar', user: rajesh }
  ];

  for (const t of targets) {
    if (!t.user) continue;
    console.log(`\n==================================================`);
    console.log(`EMPLOYEE: ${t.name} (ID: ${t.user._id})`);
    console.log(`==================================================`);

    const sessions = await LiveLocation.find({ employee: t.user._id }).sort({ createdAt: -1 });
    console.log(`Total sessions in DB: ${sessions.length}`);

    for (const s of sessions) {
      console.log(`\n--- Session ID: ${s.sessionId} | Created: ${s.startTime || s.createdAt} | Date: ${s.date} | Active: ${s.isActive} | Stored Total: ${s.totalDistance} km ---`);
      
      const coords = s.coordinates || [];
      console.log(`Total Raw Coordinates: ${coords.length}`);

      // Group coords by Date
      const dateMap = {};
      coords.forEach((c, idx) => {
        const dStr = c.timestamp ? new Date(c.timestamp).toISOString().slice(0, 10) : (c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : 'unknown');
        if (!dateMap[dStr]) dateMap[dStr] = [];
        dateMap[dStr].push({ ...c, index: idx });
      });

      console.log(`Coordinates Breakdown by Date:`);
      for (const d of Object.keys(dateMap).sort()) {
        console.log(`  📅 Date ${d}: ${dateMap[d].length} points`);
        const firstP = dateMap[d][0];
        const lastP = dateMap[d][dateMap[d].length - 1];
        console.log(`     First point: ${new Date(firstP.timestamp).toLocaleTimeString()} (${firstP.lat}, ${firstP.lng})`);
        console.log(`     Last point:  ${new Date(lastP.timestamp).toLocaleTimeString()} (${lastP.lat}, ${lastP.lng})`);
      }

      // Check Distance Ledger Breakdown by Date
      const ledgers = await DistanceLedger.find({ sessionId: s.sessionId }).sort({ toTimestamp: 1 });
      console.log(`\n  Distance Ledger Records: ${ledgers.length}`);
      
      const ledgerDateMap = {};
      ledgers.forEach(l => {
        const dStr = l.toTimestamp ? new Date(l.toTimestamp).toISOString().slice(0, 10) : 'unknown';
        if (!ledgerDateMap[dStr]) ledgerDateMap[dStr] = { count: 0, km: 0, rejectedKm: 0 };
        if (l.classification === 'ACCEPTED' || l.classification === 'RECOVERED' || l.classification === 'CANDIDATE') {
          ledgerDateMap[dStr].km += (l.distanceKm || 0);
        } else {
          ledgerDateMap[dStr].rejectedKm += (l.distanceKm || 0);
        }
        ledgerDateMap[dStr].count++;
      });

      console.log(`  Distance Ledger Breakdown by Date:`);
      for (const d of Object.keys(ledgerDateMap).sort()) {
        console.log(`     📅 Date ${d}: Accepted KM = ${ledgerDateMap[d].km.toFixed(3)} km | Rejected KM = ${ledgerDateMap[d].rejectedKm.toFixed(3)} km | Entries = ${ledgerDateMap[d].count}`);
      }

      // Detect huge gaps / jumps in coordinates
      console.log(`\n  Major Gaps (> 1 hour) & Cell Jumps in Coordinates:`);
      function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }

      for (let i = 1; i < coords.length; i++) {
        const p1 = coords[i-1];
        const p2 = coords[i];
        if (!p1.timestamp || !p2.timestamp) continue;
        const t1 = new Date(p1.timestamp).getTime();
        const t2 = new Date(p2.timestamp).getTime();
        const dtSec = (t2 - t1) / 1000;
        const dist = haversine(p1.lat, p1.lng, p2.lat, p2.lng);
        const speedKmh = dtSec > 0 ? (dist / (dtSec / 3600)) : 0;

        if (dtSec > 3600 || dist > 10 || speedKmh > 100) {
          console.log(`     ⚠️ Jump @ Point #${i-1} -> #${i}: Date1=${new Date(p1.timestamp).toISOString()} -> Date2=${new Date(p2.timestamp).toISOString()} | Gap=${(dtSec/3600).toFixed(1)}h | Dist=${dist.toFixed(2)}km | Speed=${speedKmh.toFixed(1)}km/h`);
        }
      }
    }
  }

  await mongoose.disconnect();
}

auditHistoricalData().catch(console.error);
