require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const sessions = await db.collection('livelocations').find({ date: '2026-10-15' }).toArray();
  for (const s of sessions) {
    const user = await db.collection('users').findOne({ _id: s.employee });
    const coords = s.coordinates || [];
    const first = coords[0];
    const last = coords[coords.length - 1];
    console.log(`\n=== ${user?.name} (${user?.employeeId}) | Total: ${s.totalDistance} km | Points: ${coords.length} ===`);
    console.log(`Start: ${first?.lat}, ${first?.lng} | ${first?.address}`);
    console.log(`End:   ${last?.lat}, ${last?.lng} | ${last?.address}`);
  }
  await mongoose.disconnect();
}
run().catch(console.error);
