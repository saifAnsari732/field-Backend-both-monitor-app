const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { DistanceLedger, TrackingPoint } = require('../models');
  
  const ledgers = await DistanceLedger.find({ sessionId: '6acf143754e9597d39ddac30' }).lean();
  console.log('DistanceLedger entries:', ledgers.length);
  ledgers.forEach(l => {
    console.log(l.eventType, l.distanceKm, l.reason, l.fromCoordinate, l.toCoordinate);
  });
  
  const points = await TrackingPoint.find({ sessionId: '6acf143754e9597d39ddac30' }).lean();
  console.log('TrackingPoint count:', points.length);
  process.exit(0);
}

run().catch(console.error);
