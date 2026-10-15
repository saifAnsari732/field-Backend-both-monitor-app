const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function reviveAndBroadcast() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { User, LiveLocation, Attendance, DistanceLedger } = require('../models');
  const { reconcileAllActiveSessions } = require('../controllers/tracking.controller');

  console.log('--- RUNNING SENTINEL RECONCILIATION ---');
  await reconcileAllActiveSessions();

  // Specifically verify and restore Rajesh Kumar
  const rajeshUser = await User.findOne({ employeeId: 'EMP-6FD8C90E' });
  if (rajeshUser) {
    const rSession = await LiveLocation.findOne({ employee: rajeshUser._id, date: '2026-10-15' }).sort({ createdAt: -1 });
    if (rSession) {
      await LiveLocation.updateOne(
        { _id: rSession._id },
        {
          $set: {
            isActive: true,
            autoClosed: false,
            manuallyStopped: false,
            totalDistance: 46.10,
            officialDistance: 46.10,
            acceptedDistance: 46.10,
            rawGpsDistance: 46.10,
            lastActivity: new Date()
          },
          $unset: { endTime: 1 }
        }
      );
      await Attendance.updateOne(
        { employee: rajeshUser._id, date: '2026-10-15' },
        {
          $unset: { checkOut: 1 },
          $set: { totalDistanceTraveled: 46.10 }
        }
      );
      await User.updateOne(
        { _id: rajeshUser._id },
        {
          $set: { isTracking: true, isOnline: true, lastSeen: new Date(), totalDistance: 46.10, totalDistanceToday: 46.10 }
        }
      );
      console.log('✅ Rajesh Kumar restored to ACTIVE with 46.10 KM!');
    }
  }

  // Specifically verify and restore Ankit Shukla
  const ankitUser = await User.findOne({ employeeId: 'EMP7116' });
  if (ankitUser) {
    const aSession = await LiveLocation.findOne({ employee: ankitUser._id, date: '2026-10-15' }).sort({ createdAt: -1 });
    if (aSession) {
      await LiveLocation.updateOne(
        { _id: aSession._id },
        {
          $set: {
            isActive: true,
            autoClosed: false,
            manuallyStopped: false,
            lastActivity: new Date()
          },
          $unset: { endTime: 1 }
        }
      );
      await Attendance.updateOne(
        { employee: ankitUser._id, date: '2026-10-15' },
        { $unset: { checkOut: 1 } }
      );
      await User.updateOne(
        { _id: ankitUser._id },
        { $set: { isTracking: true, isOnline: true, lastSeen: new Date() } }
      );
      console.log('✅ Ankit Shukla restored to ACTIVE!');
    }
  }

  // Now verify active sessions list
  const activeNow = await LiveLocation.find({ isActive: true, date: '2026-10-15' }).populate('employee', 'name employeeId isTracking isOnline').lean();
  console.log('=== CURRENT ACTIVE SESSIONS (COUNT: ' + activeNow.length + ') ===');
  for (const s of activeNow) {
    console.log(s.employee?.name + ' (' + s.employee?.employeeId + '): isActive=' + s.isActive + ' | Dist=' + s.totalDistance + ' km | isTracking=' + s.employee?.isTracking + ' | isOnline=' + s.employee?.isOnline);
  }

  await mongoose.disconnect();
}

reviveAndBroadcast().catch(console.error);
