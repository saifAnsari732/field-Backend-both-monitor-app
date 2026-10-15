const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User } = require('../models');
  const today = '2026-10-15';
  const sessions = await LiveLocation.find({ date: today }).populate('employee', 'name employeeId isTracking isOnline');
  console.log('--- TODAY SESSIONS (2026-10-15) --- Total:', sessions.length);
  for (const s of sessions) {
    console.log(
      (s.employee?.name || 'Unknown').padEnd(20),
      '| ID:', (s.employee?.employeeId || '').padEnd(12),
      '| isActive:', String(s.isActive).padEnd(5),
      '| isTracking:', String(s.employee?.isTracking).padEnd(5),
      '| KM:', String(s.totalDistance).padEnd(6),
      '| official:', String(s.officialDistance).padEnd(6),
      '| autoClosed:', String(s.autoClosed).padEnd(5),
      '| manuallyStopped:', String(s.manuallyStopped).padEnd(5),
      '| endTime:', s.endTime ? s.endTime.toISOString() : 'none'
    );
  }
  await mongoose.disconnect();
}
check();
