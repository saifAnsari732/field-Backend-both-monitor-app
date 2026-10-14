const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { LiveLocation, User } = require('../models');
  
  const s = await LiveLocation.findById('6acf143754e9597d39ddac30').lean();
  if (!s) {
    console.log('Session not found!');
    process.exit(0);
  }
  const user = await User.findById(s.employeeId).lean();
  console.log('Employee:', user ? user.name : 'Unknown', 'EmployeeID:', s.employeeId);
  console.log('Session totalDistance:', s.totalDistance);
  console.log('Coords count:', s.coordinates?.length);
  s.coordinates.forEach((c, idx) => {
    console.log(`[${idx}] ${c.timestamp ? new Date(c.timestamp).toLocaleTimeString() : 'no-time'} | lat: ${c.lat}, lng: ${c.lng} | speed: ${c.speed} | ${c.address || ''}`);
  });
  process.exit(0);
}

run().catch(console.error);
