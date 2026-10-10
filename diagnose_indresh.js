/**
 * diagnose_indresh.js
 * 
 * Deep Telemetry Inspection for Indresh Kumar
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, TrackingPoint, DistanceLedger, User } = require('./models/index');

async function runDiagnosis() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Find Indresh User
    const indresh = await User.findOne({ name: { $regex: /indresh/i } }).lean();
    if (!indresh) {
      console.log('❌ Indresh Kumar user not found');
      process.exit(0);
    }

    console.log('👤 USER DATA:', {
      _id: indresh._id,
      name: indresh.name,
      isTracking: indresh.isTracking,
      isOnline: indresh.isOnline,
      lastSeen: indresh.lastSeen,
      appVersion: indresh.appVersion || 'N/A'
    });

    const today = new Date().toISOString().slice(0, 10);
    const liveSessions = await LiveLocation.find({ employee: indresh._id, date: today }).sort({ createdAt: -1 }).lean();
    console.log(`\n📋 FOUND ${liveSessions.length} SESSIONS TODAY FOR INDRESH:`);

    for (const session of liveSessions) {
      console.log(`\n--- SESSION ${session.sessionId} ---`);
      console.log({
        isActive: session.isActive,
        autoClosed: session.autoClosed,
        startTime: session.startTime,
        endTime: session.endTime,
        totalDistance: session.totalDistance,
        coordCount: session.coordinates?.length || 0,
        rejectionReasonsCount: session.rejectionReasons?.length || 0
      });

      if (session.rejectionReasons && session.rejectionReasons.length > 0) {
        console.log('  ⚠️ REJECTION REASONS:', session.rejectionReasons.slice(-5));
      }

      const rawPoints = await TrackingPoint.find({ sessionId: session.sessionId }).sort({ timestamp: -1 }).limit(10).lean();
      console.log(`  Raw TrackingPoints count: ${await TrackingPoint.countDocuments({ sessionId: session.sessionId })}`);
      if (rawPoints.length > 0) {
        console.log('  Latest 3 Raw Points:', rawPoints.slice(0, 3).map(p => ({
          timestamp: p.timestamp,
          receivedAt: p.receivedAt,
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy,
          speed: p.speed,
          provider: p.provider,
          status: p.processingStatus,
          mocked: p.mocked
        })));
      }

      const ledgers = await DistanceLedger.find({ sessionId: session.sessionId }).lean();
      console.log(`  DistanceLedgers count: ${ledgers.length}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error diagnosing Indresh:', err);
    process.exit(1);
  }
}

runDiagnosis();
