/**
 * check_indresh_yesterday.js
 * 
 * Retrieves Indresh Kumar's tracking sessions, KM, Start Location, and End Location for Yesterday (2026-10-09 and 2026-10-08).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, TrackingPoint, DistanceLedger, Attendance, User } = require('./models/index');

async function checkIndreshYesterday() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB.');

    // Find Indresh User
    const indresh = await User.findOne({ name: { $regex: /indresh/i } }).lean();
    if (!indresh) {
      console.log('❌ Indresh Kumar user not found in database');
      process.exit(0);
    }

    console.log(`👤 FOUND USER: ${indresh.name} (ID: ${indresh._id}, Code: ${indresh.employeeId || 'N/A'})\n`);

    const datesToCheck = ['2026-10-09', '2026-10-08'];

    for (const targetDate of datesToCheck) {
      console.log(`================================================================`);
      console.log(`📅 AUDIT FOR DATE: ${targetDate}`);
      console.log(`================================================================`);

      // 1. Attendance Record
      const att = await Attendance.findOne({ employee: indresh._id, date: targetDate }).lean();
      if (att) {
        console.log(`📋 ATTENDANCE RECORD:`);
        console.log(`   Status: ${att.status}`);
        console.log(`   Check-In Time: ${att.checkIn ? new Date(att.checkIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`);
        console.log(`   Check-Out Time: ${att.checkOut ? new Date(att.checkOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`);
        console.log(`   Total Distance Traveled (Attendance): ${att.totalDistanceTraveled || 0} KM`);
      } else {
        console.log(`📋 ATTENDANCE RECORD: No attendance record found for ${targetDate}`);
      }

      // 2. Tracking Sessions
      const sessions = await LiveLocation.find({ employee: indresh._id, date: targetDate }).sort({ startTime: 1 }).lean();
      console.log(`\n🚗 TRACKING SESSIONS (${sessions.length} sessions found):`);

      if (sessions.length === 0) {
        console.log(`   ⚠️ No live tracking sessions found for ${targetDate}`);
      }

      for (let idx = 0; idx < sessions.length; idx++) {
        const s = sessions[idx];
        console.log(`\n   ── Session #${idx + 1} (ID: ${s.sessionId}) ──`);
        console.log(`   Active: ${s.isActive} | AutoClosed: ${s.autoClosed}`);
        console.log(`   Start Time: ${s.startTime ? new Date(s.startTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`);
        console.log(`   End Time: ${s.endTime ? new Date(s.endTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Ongoing / Active'}`);
        console.log(`   Total Distance (Session): ${s.totalDistance || 0} KM (Official: ${s.officialDistance || 0} KM)`);

        const firstCoord = s.coordinates && s.coordinates.length > 0 ? s.coordinates[0] : null;
        const lastCoord = s.coordinates && s.coordinates.length > 0 ? s.coordinates[s.coordinates.length - 1] : null;

        console.log(`   📍 START LOCATION:`);
        console.log(`      Address: ${s.startAddress || firstCoord?.address || 'N/A'}`);
        console.log(`      Coordinates: ${firstCoord ? `${firstCoord.lat}, ${firstCoord.lng}` : 'N/A'}`);
        console.log(`      Timestamp: ${firstCoord?.timestamp ? new Date(firstCoord.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`);

        console.log(`   🏁 END LOCATION:`);
        console.log(`      Address: ${s.endAddress || lastCoord?.address || 'N/A'}`);
        console.log(`      Coordinates: ${lastCoord ? `${lastCoord.lat}, ${lastCoord.lng}` : 'N/A'}`);
        console.log(`      Timestamp: ${lastCoord?.timestamp ? new Date(lastCoord.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'}`);

        const rawPoints = await TrackingPoint.countDocuments({ sessionId: s.sessionId });
        const ledgers = await DistanceLedger.find({ sessionId: s.sessionId }).lean();
        const ledgerKm = ledgers.reduce((acc, l) => acc + (l.distanceKm || 0), 0);

        console.log(`   📊 Telemetry stats:`);
        console.log(`      Total Coordinates Array length: ${s.coordinates?.length || 0}`);
        console.log(`      Raw TrackingPoint DB count: ${rawPoints}`);
        console.log(`      DistanceLedger segments count: ${ledgers.length}`);
        console.log(`      DistanceLedger Total KM: ${ledgerKm.toFixed(2)} KM`);
      }

      console.log(`\n`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error checking Indresh yesterday:', err);
    process.exit(1);
  }
}

checkIndreshYesterday();
