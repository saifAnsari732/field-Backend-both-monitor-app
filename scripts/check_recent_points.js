const mongoose = require('mongoose');
require('dotenv').config({ path: 'h:/C_Desktop_Backup/field-App/CRM-B/.env' });

async function checkRecentPoints() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User } = require('../models');

  const now = new Date();
  console.log(`CURRENT SERVER TIME: ${now.toISOString()} (${now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)\n`);

  const sessions = await LiveLocation.find({ date: '2026-10-15', isActive: true }).populate('employee', 'name employeeId isTracking lastSeen');

  for (const s of sessions) {
    const coords = s.coordinates || [];
    const len = coords.length;
    const lastCoord = len > 0 ? coords[len - 1] : null;
    const secondLast = len > 1 ? coords[len - 2] : null;

    console.log(`👤 ${s.employee?.name || 'Unknown'} [${s.employee?.employeeId}]:`);
    console.log(`   Total Distance: ${s.totalDistance} km | Official: ${s.officialDistance} km`);
    console.log(`   Total Points: ${len}`);
    if (lastCoord) {
      const lastTs = new Date(lastCoord.timestamp);
      const minAgo = ((now - lastTs) / 60000).toFixed(1);
      console.log(`   Last Point: [${lastCoord.lat?.toFixed(5)}, ${lastCoord.lng?.toFixed(5)}] at ${lastTs.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} (${minAgo} min ago)`);
      console.log(`   Last EventId: ${lastCoord.eventId || 'none'}`);
    }
    if (secondLast) {
      const prevTs = new Date(secondLast.timestamp);
      console.log(`   Prev Point: [${secondLast.lat?.toFixed(5)}, ${secondLast.lng?.toFixed(5)}] at ${prevTs.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    }
    console.log('---------------------------------------------------------');
  }

  await mongoose.disconnect();
}

checkRecentPoints().catch(console.error);
