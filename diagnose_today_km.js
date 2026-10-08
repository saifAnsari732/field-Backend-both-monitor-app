require('dotenv').config();
const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function diagnose() {
  await mongoose.connect(mongoUri);
  const { LiveLocation, User, Attendance, DistanceLedger } = require('./models');

  console.log(`\n=================== ACTIVE LIVE SESSIONS RIGHT NOW ===================\n`);

  const activeSessions = await LiveLocation.find({
    isActive: true
  }).populate('employee', 'name email phone role isTracking isOnline').sort({ createdAt: -1 });

  console.log(`Found ${activeSessions.length} CURRENTLY ACTIVE tracking sessions:\n`);

  for (const session of activeSessions) {
    const empName = session.employee?.name || session.name || 'UNKNOWN';
    const empId = session.employee?._id || session.employee || session.employeeId;
    const coordsCount = session.coordinates ? session.coordinates.length : 0;

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`👤 Employee: ${empName} (ID: ${empId})`);
    console.log(`   SessionId: ${session.sessionId} | Active: ${session.isActive}`);
    console.log(`   StartTime: ${session.startTime} | LastActivity: ${session.lastActivity}`);
    console.log(`   TotalDistance (Doc): ${session.totalDistance} KM | OfficialDistance: ${session.officialDistance} KM`);
    console.log(`   Coordinates Count in LiveLocation: ${coordsCount}`);
    
    if (coordsCount > 0) {
      const first = session.coordinates[0];
      const last = session.coordinates[coordsCount - 1];
      console.log(`   First Point:`, { lat: first.lat, lng: first.lng, ts: first.timestamp, acc: first.accuracy });
      console.log(`   Last Point:`, { lat: last.lat, lng: last.lng, ts: last.timestamp, acc: last.accuracy, spd: last.speed });
      
      const timeDiffMins = (new Date(last.timestamp || session.lastActivity) - new Date(first.timestamp || session.startTime)) / 60000;
      console.log(`   Elapsed Session Time: ${timeDiffMins.toFixed(1)} mins`);
    } else {
      console.log(`   ⚠️ ZERO POINTS SENT BY PHONE! Phone background location task is not sending GPS pings.`);
    }
    console.log(`--------------------------------------------------------------------------------\n`);
  }

  process.exit(0);
}

diagnose().catch(err => {
  console.error('Diagnosis error:', err);
  process.exit(1);
});
