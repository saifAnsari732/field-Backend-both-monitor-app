const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { ActivityLog, User } = require('../models');
  for (const empCode of ['EMP1532', 'EMP-6FD8C90E', 'EMP-EDD5FC6B']) {
    const user = await User.findOne({ employeeId: empCode });
    const logs = await ActivityLog.find({
      employee: user._id,
      action: 'TRACKING_STOP',
      createdAt: { $gte: new Date('2026-10-15T00:00:00.000Z') }
    });
    console.log(user?.name, 'TRACKING_STOP logs today count:', logs.length);
    for (const l of logs) console.log('  ', l.createdAt, l.description, l.metadata);
  }
  await mongoose.disconnect();
}
check();
