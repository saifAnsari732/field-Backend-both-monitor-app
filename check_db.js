const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, Attendance, User } = require('./models/index');

async function check() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/kisanconnect';
  await mongoose.connect(uri);
  console.log('DB connected');

  const DistanceLedger = mongoose.model('DistanceLedger');
  const TrackingPoint = mongoose.model('TrackingPoint');

  const liveLocs = await LiveLocation.find({ isActive: true }).populate('employee', 'name employeeId phone').lean();
  console.log('--- ACTIVE LIVE LOCATIONS (' + liveLocs.length + ') ---');

  for (const loc of liveLocs) {
    const pointCount = loc.coordinates ? loc.coordinates.length : 0;
    const ledgerCount = await DistanceLedger.countDocuments({ sessionId: loc.sessionId });
    const trackingCount = await TrackingPoint.countDocuments({ sessionId: loc.sessionId });
    const acceptedLedger = await DistanceLedger.aggregate([
      { $match: { sessionId: loc.sessionId, classification: 'ACCEPTED' } },
      { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
    ]);
    const ledgerKm = acceptedLedger[0]?.totalKm || 0;

    const last5 = (loc.coordinates || []).slice(-5).map(c => ({
      lat: c.lat,
      lng: c.lng,
      speed: c.speed,
      accuracy: c.accuracy,
      ts: c.timestamp,
      eventId: c.eventId
    }));

    console.log(JSON.stringify({
      name: loc.employee?.name,
      sessionId: loc.sessionId,
      totalDistance: loc.totalDistance,
      officialDistance: loc.officialDistance,
      rawCoordsCount: pointCount,
      ledgerEntries: ledgerCount,
      ledgerKm: ledgerKm,
      trackingPointsCount: trackingCount,
      lastActivity: loc.lastActivity || loc.updatedAt,
      last5Coords: last5
    }, null, 2));
  }

  process.exit(0);
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});
