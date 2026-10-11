const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function fix() {
  await mongoose.connect(URI);
  console.log('Connected to DB');

  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({}, { strict: false }));
  const Attendance = mongoose.model('Attendance', new mongoose.Schema({}, { strict: false }));

  // 1. Find today's sessions for Prakash Tiwari
  const userObjectId = new mongoose.Types.ObjectId('6aca1db9fe7c5a1fbc5b1160');
  const todaySessions = await LiveLocation.find({
    employee: userObjectId,
    date: '2026-10-11'
  }).sort({ createdAt: 1 });

  console.log(`Found ${todaySessions.length} sessions for Prakash Tiwari today (2026-10-11).`);

  for (let i = 0; i < todaySessions.length; i++) {
    const s = todaySessions[i];
    const newUniqueSessionId = uuidv4();
    console.log(`Fixing session ${s._id} (${s.startTime} - ${s.endTime}): replacing duplicate sessionId ${s.sessionId} with unique ${newUniqueSessionId}`);
    
    await LiveLocation.findByIdAndUpdate(s._id, {
      $set: {
        sessionId: newUniqueSessionId,
        totalDistance: 0,
        officialDistance: 0,
        acceptedDistance: 0,
        rawGpsDistance: 0,
        manualDistanceAdded: 0,
        coordinates: []
      }
    });
  }

  // Also check if attendance for 2026-10-11 was inflated
  const todayAttendance = await Attendance.findOne({
    employee: userObjectId,
    date: '2026-10-11'
  });
  if (todayAttendance) {
    console.log('Prakash Tiwari today attendance before fix:', todayAttendance.totalDistance, todayAttendance.totalDistanceTraveled);
    await Attendance.findByIdAndUpdate(todayAttendance._id, {
      $set: {
        totalDistance: 0,
        totalDistanceTraveled: 0
      }
    });
    console.log('Prakash Tiwari today attendance reset to 0 KM.');
  }

  console.log('✅ Fix applied for Prakash Tiwari!');
  process.exit(0);
}

fix().catch(e => { console.error(e); process.exit(1); });
