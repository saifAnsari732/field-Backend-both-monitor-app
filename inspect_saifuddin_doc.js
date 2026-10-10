require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, User } = require('./models');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';

async function inspectDoc() {
  await mongoose.connect(mongoUri);
  const user = await User.findOne({ name: { $regex: 'saifuddin', $options: 'i' } });
  const activeLoc = await LiveLocation.findOne({ employee: user._id, isActive: true }).sort({ createdAt: -1 });

  console.log('Document keys:', Object.keys(activeLoc._doc));
  console.log('Raw doc:', JSON.stringify({
    _id: activeLoc._id,
    employee: activeLoc.employee,
    totalDistance: activeLoc.totalDistance,
    officialDistance: activeLoc.officialDistance,
    currentLocation: activeLoc.currentLocation,
    coordinatesLength: activeLoc.coordinates ? activeLoc.coordinates.length : 0,
    lastActivity: activeLoc.lastActivity,
    algorithmVersion: activeLoc.algorithmVersion
  }, null, 2));

  process.exit(0);
}

inspectDoc();
