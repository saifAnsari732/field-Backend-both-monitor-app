const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function fullAudit() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { User, LiveLocation, Attendance } = require('../models');

  const todayStr = '2026-10-15';
  const employees = await User.find({ role: { $in: ['employee', 'EMPLOYEE', 'manager', 'MANAGER'] } }).lean();

  console.log('=== FULL AUDIT OF ALL EMPLOYEES TODAY (' + new Date().toISOString() + ') ===');
  for (const emp of employees) {
    const session = await LiveLocation.findOne({ employee: emp._id, isActive: true }).lean();
    const todaySessions = await LiveLocation.find({ employee: emp._id, date: todayStr }).sort({ createdAt: -1 }).lean();
    const att = await Attendance.findOne({ employee: emp._id, date: todayStr }).lean();

    const latestSession = todaySessions[0];
    const totalKm = latestSession ? (latestSession.officialDistance ?? latestSession.totalDistance ?? 0) : (att?.totalDistanceTraveled || 0);

    const lastCoord = session?.coordinates?.length > 0 ? session.coordinates[session.coordinates.length - 1] : null;
    const lastCoordTime = lastCoord ? lastCoord.timestamp.toISOString() : 'none';

    console.log('----------------------------------------------------');
    console.log(emp.name + ' (' + emp.employeeId + ') - Role: ' + emp.role);
    console.log('  User.isTracking: ' + emp.isTracking + ' | User.isOnline: ' + emp.isOnline);
    console.log('  Active Session: ' + (session ? 'YES (' + session.sessionId + ')' : 'NO'));
    console.log('  Today KM: ' + totalKm + ' km');
    console.log('  Attendance: ' + (att ? 'Checked In: ' + (att.checkIn ? att.checkIn.toISOString() : 'none') + ' | Checked Out: ' + (att.checkOut ? att.checkOut.toISOString() : 'none') : 'NO ATTENDANCE'));
    if (session) {
      console.log('  Last Activity: ' + (session.lastActivity ? session.lastActivity.toISOString() : 'none'));
      console.log('  Last Coord Time: ' + lastCoordTime + ' (coords count: ' + session.coordinates?.length + ')');
      console.log('  Motion State: ' + session.motionState);
    } else if (latestSession) {
      console.log('  Latest Inactive Session: ' + latestSession.sessionId + ' (ended: ' + latestSession.endTime + ', manuallyStopped: ' + latestSession.manuallyStopped + ')');
    }
  }

  await mongoose.disconnect();
}
fullAudit().catch(console.error);
