require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({}).toArray();
  const userMap = {};
  users.forEach(u => userMap[u._id.toString()] = u);

  const sessions = await db.collection('livelocations').find({ date: '2026-10-15' }).toArray();

  for (const s of sessions) {
    const user = userMap[s.employee.toString()];
    console.log(`\n================================================================`);
    console.log(`EMPLOYEE: ${user?.name} (${user?.employeeId}) | Session: ${s.sessionId}`);
    console.log(`Total Distance: ${s.totalDistance} km | Official: ${s.officialDistance} km | Raw GPS: ${s.rawGpsDistance} km | Accepted: ${s.acceptedDistance} km`);
    console.log(`Coordinates Count: ${s.coordinates?.length || 0}`);

    // Check DistanceLedger breakdown by reason
    const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
    const reasonMap = {};
    let sumLedgerKm = 0;
    for (const l of ledgers) {
      const r = `${l.classification}:${l.reason}`;
      if (!reasonMap[r]) reasonMap[r] = { count: 0, km: 0 };
      reasonMap[r].count++;
      reasonMap[r].km += (l.distanceKm || 0);
      if (l.classification === 'ACCEPTED' || l.classification === 'RECOVERED') {
        sumLedgerKm += (l.distanceKm || 0);
      }
    }
    console.log(`Sum of Accepted/Recovered Ledgers: ${sumLedgerKm.toFixed(2)} km`);
    console.log('Breakdown by reason:');
    for (const [r, v] of Object.entries(reasonMap)) {
      console.log(`  - ${r}: ${v.count} segments, ${v.km.toFixed(2)} km`);
    }

    // Check if there are duplicate or overlapping coordinate streams
    const coords = s.coordinates || [];
    let duplicateTimestamps = 0;
    let duplicateEventIds = 0;
    let screenCapturedCount = 0;
    let syncEventCount = 0;
    const tsSet = new Set();
    const evSet = new Set();
    for (const c of coords) {
      const ts = new Date(c.timestamp).getTime();
      if (tsSet.has(ts)) duplicateTimestamps++;
      tsSet.add(ts);
      if (c.eventId) {
        if (evSet.has(c.eventId)) duplicateEventIds++;
        evSet.add(c.eventId);
        if (c.eventId.includes(':sync:')) syncEventCount++;
      }
      if (c.screenCaptured) screenCapturedCount++;
    }
    console.log(`Duplicate TS: ${duplicateTimestamps}, Duplicate eventId: ${duplicateEventIds}, ScreenCaptured: ${screenCapturedCount}, SyncEventCount: ${syncEventCount}`);
  }

  await mongoose.disconnect();
}

run().catch(console.error);
