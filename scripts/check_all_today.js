require('dotenv').config();
const mongoose = require('mongoose');

async function checkSessions() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const startOfDay = new Date('2026-10-15T00:00:00.000Z');
  const allToday = await db.collection('livelocations').find({
    $or: [
      { date: '2026-10-15' },
      { createdAt: { $gte: startOfDay } }
    ]
  }).toArray();
  console.log('Total sessions today across all employees:', allToday.length);
  for (const s of allToday) {
    const user = await db.collection('users').findOne({ _id: s.employee });
    console.log(`  Emp: ${user?.name || s.employee} (${user?.employeeId}), Session ${s.sessionId}, date: ${s.date}, isActive: ${s.isActive}, totalDist: ${s.totalDistance}, officialDist: ${s.officialDistance}`);
  }
  await mongoose.disconnect();
}
checkSessions().catch(console.error);
