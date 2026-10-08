const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, Attendance, User } = require('./models/index');

async function checkNow() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/kisanconnect';
  await mongoose.connect(uri);
  console.log('DB connected');

  const DistanceLedger = mongoose.model('DistanceLedger');

  const allActiveSessions = await LiveLocation.find({ isActive: true }).populate('employee', 'name phone role').lean();
  console.log('=== CURRENT ACTIVE SESSIONS (' + allActiveSessions.length + ') ===\n');

  for (const session of allActiveSessions) {
    const empName = session.employee?.name || 'Unknown';
    const coords = session.coordinates || [];
    const lastCoord = coords[coords.length - 1] || {};

    const ledgerAgg = await DistanceLedger.aggregate([
      { $match: { sessionId: session.sessionId, classification: 'ACCEPTED' } },
      { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
    ]);
    const ledgerKm = ledgerAgg[0]?.totalKm || 0;

    console.log(JSON.stringify({
      employee: empName,
      phone: session.employee?.phone,
      sessionId: session.sessionId,
      totalDistance: session.totalDistance,
      officialDistance: session.officialDistance,
      ledgerKm: ledgerKm,
      rawCoordsCount: coords.length,
      lastActivity: session.lastActivity || session.updatedAt,
      lastCoordTimestamp: lastCoord.timestamp,
      lastAddress: lastCoord.address || session.startAddress
    }, null, 2));
  }

  process.exit(0);
}

checkNow().catch(e => {
  console.error(e);
  process.exit(1);
});
