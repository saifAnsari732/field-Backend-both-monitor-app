const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function auditGpsStream() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User, DistanceLedger } = require('../models');

  const today = '2026-10-15';
  const now = new Date();

  console.log('========================================================================');
  console.log(`📡 REAL-TIME GPS STREAM & PIPELINE AUDIT (${now.toISOString()})`);
  console.log('========================================================================\n');

  const activeSessions = await LiveLocation.find({ date: today }).populate('employee', 'name employeeId isTracking isOnline lastSeen');

  for (const s of activeSessions) {
    const empName = s.employee?.name || 'Unknown';
    const empId = s.employee?.employeeId || 'Unknown';
    const totalPoints = s.coordinates?.length || 0;
    
    // Last coordinate info
    const lastCoord = totalPoints > 0 ? s.coordinates[totalPoints - 1] : null;
    const lastTs = lastCoord?.timestamp ? new Date(lastCoord.timestamp) : null;
    const minutesSinceLastCoord = lastTs ? Math.round((now - lastTs) / 60000) : 'N/A';
    
    // Check points received in last 30 minutes
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const recentCoords = (s.coordinates || []).filter(c => new Date(c.timestamp) >= thirtyMinAgo);

    // DistanceLedger breakdown for this session
    const ledgerStats = await DistanceLedger.aggregate([
      { $match: { sessionId: s.sessionId } },
      { $group: { _id: '$classification', count: { $sum: 1 }, totalKm: { $sum: '$distanceKm' } } }
    ]);

    const acceptedKm = ledgerStats.find(x => x._id === 'ACCEPTED')?.totalKm || 0;
    const recoveredKm = ledgerStats.find(x => x._id === 'RECOVERED')?.totalKm || 0;
    const rejectedCount = ledgerStats.find(x => x._id === 'REJECTED')?.count || 0;

    // Check last 5 distance ledger entries to verify recent movement calculations
    const recentLedgers = await DistanceLedger.find({ sessionId: s.sessionId })
      .sort({ createdAt: -1 })
      .limit(3);

    console.log(`👤 Employee: ${empName.padEnd(20)} [${empId}]`);
    console.log(`   Session: ${s.sessionId} | isActive: ${s.isActive} | isTracking: ${s.employee?.isTracking}`);
    console.log(`   KM: Official: ${s.officialDistance} km | Total: ${s.totalDistance} km | Ledger Accepted: ${acceptedKm.toFixed(2)} km`);
    console.log(`   Points: Total: ${totalPoints} | Recent (last 30m): ${recentCoords.length}`);
    console.log(`   Last Fix: ${lastTs ? lastTs.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'None'} (${minutesSinceLastCoord} min ago)`);
    if (lastCoord) {
      console.log(`   Last Location: [${lastCoord.lat?.toFixed(5)}, ${lastCoord.lng?.toFixed(5)}] | Acc: ${lastCoord.accuracy || 'N/A'}m | Speed: ${lastCoord.speed || 0}`);
    }
    console.log(`   Ledger: Accepted: ${acceptedKm.toFixed(2)} km | Recovered: ${recoveredKm.toFixed(2)} km | Rejected: ${rejectedCount} points`);
    if (recentLedgers.length > 0) {
      console.log(`   Recent Increments: ${recentLedgers.map(l => `${l.distanceKm.toFixed(3)}km (${l.classification})`).join(', ')}`);
    }
    console.log('------------------------------------------------------------------------');
  }

  // Check top rejection reasons today to ensure no valid coordinates are being dropped
  console.log('\n🔎 AUDIT: TOP REJECTION REASONS IN DISTANCE LEDGER TODAY:');
  const rejectionReasons = await DistanceLedger.aggregate([
    { $match: { createdAt: { $gte: new Date('2026-10-15T00:00:00.000Z') }, classification: 'REJECTED' } },
    { $group: { _id: '$reason', count: { $sum: 1 }, totalDroppedKm: { $sum: '$distanceKm' } } },
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);
  console.table(rejectionReasons);

  await mongoose.disconnect();
}

auditGpsStream().catch(console.error);
