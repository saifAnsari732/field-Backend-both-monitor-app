const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function checkOrg() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User } = require('../models');

  const todayStr = '2026-10-15';
  const startOfDay = new Date(todayStr + 'T00:00:00.000Z');
  const sessions = await LiveLocation.find({ startTime: { $gte: startOfDay } }).populate('employee', 'name employeeId role organizationId isTracking isOnline').lean();

  console.log('Today sessions count:', sessions.length);
  for (const s of sessions) {
    console.log(s.employee?.name, '| EmpID:', s.employee?.employeeId, '| isTracking:', s.employee?.isTracking, '| isOnline:', s.employee?.isOnline, '| EmpOrg:', s.employee?.organizationId, '| SessOrg:', s.organizationId, '| session.isActive:', s.isActive);
  }

  const admins = await User.find({ role: { $in: ['admin', 'super_admin', 'manager'] } }).select('name role organizationId').lean();
  console.log('--- ADMINS & MANAGERS ---');
  for (const a of admins) {
    console.log(a.name, '| Role:', a.role, '| Org:', a.organizationId);
  }

  await mongoose.disconnect();
}
checkOrg().catch(console.error);
