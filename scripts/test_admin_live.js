const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function testAdminLive() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { User, LiveLocation } = require('../models');

  const roles = await User.distinct('role');
  console.log('Distinct roles in DB:', roles);

  const nonEmp = await User.find({ role: { $ne: 'employee' } }).select('name role email employeeId organizationId').lean();
  console.log('Non-employee users:', nonEmp);

  const testUser = nonEmp[0] || await User.findOne().lean();
  console.log('Testing with user:', testUser.name, 'Role:', testUser.role, 'Org:', testUser.organizationId);

  const userRole = (testUser.role || '').toUpperCase();
  const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
  const orgId = testUser.organizationId;

  const userScope = isSuperAdmin ? {} : { organizationId: orgId };
  const orgEmployees = await User.find(userScope).select('_id name role employeeId isTracking isOnline').lean();
  console.log('Total scoped employees:', orgEmployees.length);

  const empIds = orgEmployees.map(e => e._id);
  const cutoff = new Date(Date.now() - 14 * 60 * 60 * 1000);

  const activeSessions = await LiveLocation.find(
    {
      isActive: true,
      employee: { $in: empIds },
      $or: [
        { lastActivity: { $gte: cutoff } },
        { lastActivity: null, updatedAt: { $gte: cutoff } }
      ]
    },
    { coordinates: { $slice: -1 }, rejectionReasons: 0 }
  ).populate('employee', 'name employeeId isTracking isOnline').lean();

  console.log('Active sessions found for user:', activeSessions.length);
  for (const s of activeSessions) {
    console.log(s.employee?.name, '| EmpID:', s.employee?.employeeId, '| isTracking:', s.employee?.isTracking, '| isOnline:', s.employee?.isOnline, '| session.isActive:', s.isActive, '| totalDistance:', s.totalDistance);
  }

  await mongoose.disconnect();
}
testAdminLive().catch(console.error);
