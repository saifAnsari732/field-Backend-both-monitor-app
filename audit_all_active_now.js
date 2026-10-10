/**
 * audit_all_active_now.js
 * 
 * Deep Live Telemetry Audit for All Employees Right Now
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, TrackingPoint, DistanceLedger, User } = require('./models/index');

async function auditNow() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB.');

    const today = new Date().toISOString().slice(0, 10);
    console.log(`\n🔍 DEEP AUDIT FOR DATE: ${today} (Current Time: ${new Date().toISOString()})\n`);

    const users = await User.find({ role: { $ne: 'SUPER_ADMIN' } }).select('name employeeId isTracking isOnline lastSeen appVersion').lean();

    for (const user of users) {
      const activeSession = await LiveLocation.findOne({ employee: user._id, isActive: true, date: today }).sort({ createdAt: -1 }).lean();
      if (!activeSession) continue;

      const rawCount = await TrackingPoint.countDocuments({ sessionId: activeSession.sessionId });
      const lastRawPoint = await TrackingPoint.findOne({ sessionId: activeSession.sessionId }).sort({ timestamp: -1 }).lean();
      const ledgerCount = await DistanceLedger.countDocuments({ sessionId: activeSession.sessionId });

      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: activeSession.sessionId, classification: { $in: ['ACCEPTED', 'RECOVERED'] } } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      const ledgerKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;

      const lastPointAgeMinutes = lastRawPoint ? Math.round((Date.now() - new Date(lastRawPoint.timestamp).getTime()) / 60000) : 9999;

      console.log(`👤 ${user.name} (${user.employeeId || 'NoID'})`);
      console.log(`   SessionID: ${activeSession.sessionId}`);
      console.log(`   IsOnline: ${user.isOnline ? '🟢 YES' : '🔴 NO'} | LastSeen: ${user.lastSeen ? new Date(user.lastSeen).toLocaleTimeString('en-IN') : 'N/A'}`);
      console.log(`   Total Raw Points: ${rawCount} | Last Point Received: ${lastRawPoint ? new Date(lastRawPoint.timestamp).toLocaleTimeString('en-IN') + ` (${lastPointAgeMinutes} min ago)` : 'NONE'}`);
      console.log(`   DistanceLedger Segments: ${ledgerCount} | Ledger Calculated KM: ${ledgerKm} KM`);
      console.log(`   LiveLocation Total Distance: ${activeSession.totalDistance} KM`);
      console.log(`   ------------------------------------------------------------`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Audit error:', err);
    process.exit(1);
  }
}

auditNow();
