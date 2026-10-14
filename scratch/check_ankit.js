const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  console.log('Connecting to:', process.env.MONGODB_URI ? 'URI present' : 'URI missing');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB!');
  const { LiveLocation, User } = require('../models');
  
  const allLive = await LiveLocation.find({}).lean();
  console.log('Total LiveLocation records:', allLive.length);
  for (const l of allLive) {
    console.log(`ID: ${l._id} | empId: ${l.employeeId} | active: ${l.isActive} | dist: ${l.totalDistance} | coords: ${l.coordinates?.length}`);
    if (l.coordinates && l.coordinates.length > 0) {
      const first = l.coordinates[0];
      const last = l.coordinates[l.coordinates.length - 1];
      console.log(`  -> First: ${first.lat}, ${first.lng} (${first.address || ''})`);
      console.log(`  -> Last:  ${last.lat}, ${last.lng} (${last.address || ''})`);
    }
  }
  process.exit(0);
}

run().catch(console.error);
