const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, Attendance, User } = require('./models/index');

async function check() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/kisanconnect';
  await mongoose.connect(uri);
  console.log('DB connected');

  const DistanceLedger = mongoose.model('DistanceLedger');

  // Find user SAIFUDDIN ANSARI
  const users = await User.find({ name: { $regex: /SAIFUDDIN/i } }).lean();
  console.log('Found users matching SAIFUDDIN:', users.map(u => ({ id: u._id, name: u.name, phone: u.phone, isTracking: u.isTracking })));

  const todayStr = new Date().toISOString().slice(0, 10);
  console.log('Today date:', todayStr);

  for (const user of users) {
    const attendance = await Attendance.findOne({ employee: user._id, date: todayStr }).lean();
    console.log('\n--- ATTENDANCE RECORD ---');
    console.log(attendance);

    const activeSessions = await LiveLocation.find({ employee: user._id, date: todayStr }).lean();
    console.log('\n--- SESSIONS TODAY (' + activeSessions.length + ') ---');

    for (const session of activeSessions) {
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: session.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);

      console.log({
        sessionId: session.sessionId,
        isActive: session.isActive,
        startTime: session.startTime,
        endTime: session.endTime,
        totalDistance: session.totalDistance,
        officialDistance: session.officialDistance,
        ledgerKm: ledgerAgg[0]?.totalKm || 0,
        coordsCount: session.coordinates ? session.coordinates.length : 0,
        lastActivity: session.lastActivity || session.updatedAt
      });
    }
  }

  process.exit(0);
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});
