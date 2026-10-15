const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, DistanceLedger, User } = require('../models');
  const user = await User.findOne({ employeeId: 'EMP-6FD8C90E' });
  const doc = await LiveLocation.findOne({ employee: user._id, date: '2026-10-15' });
  console.log('Rajesh session:', doc?.sessionId, 'totalDistance:', doc?.totalDistance, 'officialDistance:', doc?.officialDistance, 'acceptedDistance:', doc?.acceptedDistance);
  const agg = await DistanceLedger.aggregate([
    { $match: { sessionId: doc?.sessionId } },
    { $group: { _id: '$classification', count: { $sum: 1 }, totalKm: { $sum: '$distanceKm' } } }
  ]);
  console.log('DistanceLedger breakdown:', agg);

  // Check sync entries in ledger
  const syncCount = await DistanceLedger.countDocuments({
    sessionId: doc?.sessionId,
    $or: [
      { fromEventId: { $regex: ':sync:' } },
      { toEventId: { $regex: ':sync:' } }
    ]
  });
  console.log('Sync ledger count for Rajesh:', syncCount);

  await mongoose.disconnect();
}
check();
