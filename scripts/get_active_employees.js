require('dotenv').config();
const mongoose = require('mongoose');

async function getActive() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const today = '2026-10-15';

  // 1. Find live locations currently active
  const activeLocations = await db.collection('livelocations').find({
    isActive: true,
    date: today
  }).toArray();

  console.log(`--- ACTIVE LIVE LOCATION SESSIONS (${activeLocations.length}) ---`);

  const results = [];

  for (const loc of activeLocations) {
    const user = await db.collection('users').findOne({ _id: loc.employee });
    const coords = loc.coordinates || [];
    const lastCoord = coords.length > 0 ? coords[coords.length - 1] : null;

    results.push({
      name: user?.name || 'Unknown',
      employeeId: user?.employeeId || 'N/A',
      phone: user?.phone || 'N/A',
      designation: user?.designation || user?.role || 'Field Staff',
      department: user?.department || 'Field Staff',
      isTracking: user?.isTracking,
      sessionId: loc.sessionId,
      totalDistance: loc.officialDistance || loc.totalDistance || 0,
      lastActivity: loc.lastActivity || loc.updatedAt,
      lastAddress: loc.currentAddress || lastCoord?.address || loc.startAddress || 'Location recorded',
      lastLat: lastCoord?.lat || loc.lastLat,
      lastLng: lastCoord?.lng || loc.lastLng,
      speedKmh: lastCoord?.speed ? Math.round(Number(lastCoord.speed) * 3.6) : 0,
      startTime: loc.startTime
    });
  }

  // Also check if any users have isTracking: true but no active livelocation today
  const activeEmpIds = activeLocations.map(l => l.employee);
  const otherTrackingUsers = await db.collection('users').find({
    isTracking: true,
    _id: { $nin: activeEmpIds }
  }).toArray();

  console.log(JSON.stringify({ activeEmployees: results, otherTrackingUsersCount: otherTrackingUsers.length, otherTrackingUsers: otherTrackingUsers.map(u => ({ name: u.name, employeeId: u.employeeId })) }, null, 2));

  await mongoose.disconnect();
}

getActive().catch(console.error);
