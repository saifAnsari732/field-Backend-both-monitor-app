const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, Attendance, User } = require('./models/index');

async function audit() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/kisanconnect';
  await mongoose.connect(uri);
  console.log('DB connected');

  const DistanceLedger = mongoose.model('DistanceLedger');
  const TrackingPoint = mongoose.model('TrackingPoint');

  const todayStr = new Date().toISOString().slice(0, 10);
  console.log('=== TODAY DATA RECOVERY AUDIT (' + todayStr + ') ===\n');

  // Find all attendance records for today
  const attendances = await Attendance.find({ date: todayStr }).populate('employee', 'name employeeId phone').lean();

  for (const att of attendances) {
    const emp = att.employee || {};
    const empId = emp._id || att.employee;

    // Find all sessions for this employee today
    const sessions = await LiveLocation.find({ employee: empId, date: todayStr }).lean();

    let totalRawCoords = 0;
    let totalLedgerKm = 0;
    let totalTrackingPoints = 0;
    let recoveredKmCandidate = 0;

    for (const session of sessions) {
      const coords = session.coordinates || [];
      totalRawCoords += coords.length;

      // Check distance from raw coordinates (Haversine over all raw coordinates)
      let rawDistKm = 0;
      if (coords.length >= 2) {
        for (let i = 1; i < coords.length; i++) {
          const c1 = coords[i - 1];
          const c2 = coords[i];
          if (c1.lat && c1.lng && c2.lat && c2.lng) {
            const dLat = (c2.lat - c1.lat) * Math.PI / 180;
            const dLng = (c2.lng - c1.lng) * Math.PI / 180;
            const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(c1.lat*Math.PI/180)*Math.cos(c2.lat*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const d = 6371 * c; // Earth radius in km
            if (d <= 50) { // filter out teleports > 50km
              rawDistKm += d;
            }
          }
        }
      }

      // Check distance ledger sum
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: session.sessionId } },
        { $group: { _id: '$classification', totalKm: { $sum: '$distanceKm' }, count: { $sum: 1 } } }
      ]);

      const trackingCount = await TrackingPoint.countDocuments({ sessionId: session.sessionId });
      totalTrackingPoints += trackingCount;

      console.log({
        employee: emp.name || 'Unknown',
        phone: emp.phone,
        sessionId: session.sessionId,
        isActive: session.isActive,
        checkIn: att.checkIn,
        checkOut: att.checkOut,
        storedTotalKm: session.totalDistance,
        rawCoordsInDoc: coords.length,
        rawTrajectoryDistKm: Math.round(rawDistKm * 100) / 100,
        ledgerBreakdown: ledgerAgg,
        trackingPointsCount: trackingCount
      });
    }
  }

  process.exit(0);
}

audit().catch(e => {
  console.error(e);
  process.exit(1);
});
