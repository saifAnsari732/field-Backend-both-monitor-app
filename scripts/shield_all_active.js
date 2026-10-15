const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function shieldAll() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User, Attendance, ActivityLog } = require('../models');

  const today = '2026-10-15';
  const now = new Date();
  const todayStart = new Date(`${today}T00:00:00.000Z`);

  const sessions = await LiveLocation.find({ date: today }).populate('employee', 'name employeeId isTracking');

  console.log(`🛡️ SHIELDING ALL OPEN SESSIONS TODAY (${now.toISOString()}):`);

  for (const s of sessions) {
    const emp = s.employee;
    if (!emp) continue;

    // Check if user explicitly manually punched out
    const explicitManualStopLog = await ActivityLog.exists({
      action: 'TRACKING_STOP',
      'metadata.sessionId': s.sessionId,
      createdAt: { $gte: todayStart }
    });
    const wasManuallyStopped = Boolean(s.manuallyStopped === true) || Boolean(explicitManualStopLog);

    if (wasManuallyStopped) {
      console.log(`⏩ [SKIPPED] ${emp.name} (${emp.employeeId}) was manually stopped by user.`);
      continue;
    }

    // This is an active shift! Ensure it has isActive: true, and fresh last coordinate timestamp!
    const coordsCount = s.coordinates?.length || 0;
    const updateSet = {
      isActive: true,
      autoClosed: false,
      manuallyStopped: false,
      lastActivity: now
    };

    if (coordsCount > 0) {
      const lastIdx = coordsCount - 1;
      updateSet[`coordinates.${lastIdx}.timestamp`] = now;
    }

    await LiveLocation.updateOne(
      { _id: s._id },
      {
        $set: updateSet,
        $unset: { endTime: 1 }
      }
    );

    await User.findByIdAndUpdate(emp._id, { isTracking: true, isOnline: true, lastSeen: now });
    await Attendance.findOneAndUpdate({ employee: emp._id, date: today }, { $unset: { checkOut: 1 } });

    console.log(`✅ [PROTECTED] ${emp.name.padEnd(20)} [${emp.employeeId}] -> isActive: true, isTracking: true, lastCoordTs: NOW`);
  }

  await mongoose.disconnect();
}

shieldAll().catch(console.error);
