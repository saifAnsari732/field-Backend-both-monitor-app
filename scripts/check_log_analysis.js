require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, DistanceLedger } = require('../models/index');
  const sid = '9878cbe7-34ba-476c-afbf-f1fdd6ff69b7';
  
  const ledgers = await DistanceLedger.find({ sessionId: sid, distanceKm: { $gt: 5 } }).sort({ distanceKm: -1 });
  console.log('=== LARGE LEDGERS FOR 9878cbe7-34ba-476c-afbf-f1fdd6ff69b7 ===');
  console.log('Count:', ledgers.length);
  for (const l of ledgers) {
    console.log({
      km: l.distanceKm,
      class: l.classification,
      reason: l.reason,
      fromTime: l.fromTimestamp,
      toTime: l.toTimestamp,
      from: [l.fromLat, l.fromLng],
      to: [l.toLat, l.toLng]
    });
  }

  // Also check Lalit Mishra's session 3655b091-8980-4256-9067-83fbc7e04060
  const sidLalit = '3655b091-8980-4256-9067-83fbc7e04060';
  const ledgersLalit = await DistanceLedger.find({ sessionId: sidLalit, distanceKm: { $gt: 5 } }).sort({ distanceKm: -1 });
  console.log('\n=== LARGE LEDGERS FOR LALIT (3655b091-8980-4256-9067-83fbc7e04060) ===');
  console.log('Count:', ledgersLalit.length);
  for (const l of ledgersLalit) {
    console.log({
      km: l.distanceKm,
      class: l.classification,
      reason: l.reason,
      fromTime: l.fromTimestamp,
      toTime: l.toTimestamp,
      from: [l.fromLat, l.fromLng],
      to: [l.toLat, l.toLng]
    });
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
