require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No MONGO_URI in .env');
    return;
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({
    $or: [
      { name: /ajay/i },
      { employeeId: /6920/i }
    ]
  }).toArray();

  console.log('--- USER ---');
  console.log(users.map(u => ({ id: u._id, name: u.name, employeeId: u.employeeId, role: u.role, isTracking: u.isTracking, isOnline: u.isOnline, lastSeen: u.lastSeen })));

  if (users.length > 0) {
    const user = users[0];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    console.log('\n--- TODAY SESSIONS --- (date:', today, ')');
    const sessions = await db.collection('livelocations').find({
      employee: user._id,
      date: today
    }).toArray();

    console.log('Session count:', sessions.length);
    for (const s of sessions) {
      console.log({
        sessionId: s.sessionId,
        isActive: s.isActive,
        autoClosed: s.autoClosed,
        manuallyStopped: s.manuallyStopped,
        startTime: s.startTime,
        endTime: s.endTime,
        lastActivity: s.lastActivity,
        totalDistance: s.totalDistance,
        officialDistance: s.officialDistance,
        coordCount: s.coordinates ? s.coordinates.length : 0,
        gpsPointCount: s.gpsPointCount,
        acceptedPointCount: s.acceptedPointCount,
        rejectedPointCount: s.rejectedPointCount,
        motionState: s.motionState
      });

      if (s.coordinates && s.coordinates.length > 0) {
        console.log('\nTotal Coords in DB:', s.coordinates.length);
        console.log('First coord:', s.coordinates[0]);
        console.log('Last coord:', s.coordinates[s.coordinates.length - 1]);
        console.log('\nAll Coords overview:');
        s.coordinates.forEach((c, idx) => {
          console.log(`[${idx + 1}] TS: ${c.timestamp} | Lat: ${c.lat}, Lng: ${c.lng} | Acc: ${c.accuracy} | Speed: ${c.speed} | Addr: ${c.address}`);
        });
      }

      if (s.rejectionReasons && s.rejectionReasons.length > 0) {
        console.log('\nRejection reasons count:', s.rejectionReasons.length);
        console.log('Sample rejection reasons:', s.rejectionReasons.slice(-10));
      }
    }

    console.log('\n--- ATTENDANCE ---');
    const att = await db.collection('attendances').find({
      employee: user._id,
      date: today
    }).toArray();
    console.log(att.map(a => ({ checkIn: a.checkIn, checkOut: a.checkOut, status: a.status, totalDistanceTraveled: a.totalDistanceTraveled })));

    console.log('\n--- RECENT ACTIVITY LOGS ---');
    const logs = await db.collection('activitylogs').find({
      employee: user._id
    }).sort({ timestamp: -1 }).limit(10).toArray();
    console.log(logs.map(l => ({ action: l.action, description: l.description, ts: l.timestamp, metadata: l.metadata })));
  }

  await mongoose.disconnect();
}

check().catch(console.error);
