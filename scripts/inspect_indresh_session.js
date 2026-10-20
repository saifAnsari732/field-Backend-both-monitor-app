require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, DistanceLedger, Attendance, User } = require('../models/index');
  const sid = '9878cbe7-34ba-476c-afbf-f1fdd6ff69b7';
  
  const s = await LiveLocation.findOne({ sessionId: sid });
  console.log('LiveLocation:', {
    sessionId: s.sessionId,
    employee: s.employee,
    date: s.date,
    isActive: s.isActive,
    totalDistance: s.totalDistance,
    officialDistance: s.officialDistance,
    acceptedDistance: s.acceptedDistance,
    unverifiedDistance: s.unverifiedDistance,
  });

  const agg = await DistanceLedger.aggregate([
    { $match: { sessionId: sid } },
    { $group: { _id: '$classification', totalKm: { $sum: '$distanceKm' }, count: { $sum: 1 } } }
  ]);
  console.log('Ledger aggregates:', agg);

  // Check user & attendance
  const u = await User.findById(s.employee);
  console.log('User:', { name: u.name, totalDistance: u.totalDistance, totalDistanceToday: u.totalDistanceToday });

  const att = await Attendance.findOne({ employee: s.employee, date: s.date });
  console.log('Attendance:', { date: att?.date, totalDistanceTraveled: att?.totalDistanceTraveled });

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
