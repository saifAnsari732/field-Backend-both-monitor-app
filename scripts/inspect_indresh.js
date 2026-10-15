const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User, ActivityLog } = require('../models');

  for (const empCode of ['EMP1532', 'EMP4711']) {
    const user = await User.findOne({ employeeId: empCode });
    const s = await LiveLocation.findOne({ employee: user._id, date: '2026-10-15' });
    console.log(`\n--- ${user?.name} [${empCode}] ---`);
    console.log('Session:', {
      _id: s?._id,
      sessionId: s?.sessionId,
      isActive: s?.isActive,
      manuallyStopped: s?.manuallyStopped,
      autoClosed: s?.autoClosed,
      endTime: s?.endTime,
      lastActivity: s?.lastActivity,
      updatedAt: s?.updatedAt
    });

    const logs = await ActivityLog.find({ employee: user._id }).sort({ _id: -1 }).limit(5);
    console.log('Recent logs:');
    for (const l of logs) {
      console.log(l.createdAt?.toISOString(), '|', l.action, '|', l.description);
    }
  }

  await mongoose.disconnect();
}
check();
