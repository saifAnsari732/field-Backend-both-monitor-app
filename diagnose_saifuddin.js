require('dotenv').config();
const mongoose = require('mongoose');
const { User, LiveLocation, TrackingPoint, DistanceLedger } = require('./models');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';

async function checkSaifuddin() {
  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB Atlas');

  const user = await User.findOne({ name: { $regex: 'saifuddin', $options: 'i' } });
  if (!user) {
    console.log('❌ User Saifuddin not found by name!');
    const users = await User.find({}, 'name phone role isTracking');
    console.log('All Users:', users);
    process.exit(0);
  }

  console.log('\n=== USER DETAILS ===');
  console.log('ID:', user._id);
  console.log('Name:', user.name);
  console.log('Phone:', user.phone);
  console.log('isTracking:', user.isTracking);

  const activeLoc = await LiveLocation.findOne({ employee: user._id, isActive: true }).sort({ createdAt: -1 });
  
  if (!activeLoc) {
    console.log('\n❌ No active LiveLocation found for Saifuddin.');
    const lastLoc = await LiveLocation.findOne({ employee: user._id }).sort({ createdAt: -1 });
    console.log('Last LiveLocation:', lastLoc);
  } else {
    console.log('\n=== ACTIVE LIVE LOCATION SESSION ===');
    console.log('Session ID:', activeLoc._id);
    console.log('Total Distance:', activeLoc.totalDistance, 'km');
    console.log('Official Distance:', activeLoc.officialDistance, 'km');
    console.log('Coordinate Count in Array:', activeLoc.coordinates ? activeLoc.coordinates.length : 0);
    console.log('Start Time:', activeLoc.startTime);
    console.log('Last Activity:', activeLoc.lastActivity);
    console.log('Algorithm Version:', activeLoc.algorithmVersion);
    console.log('Current Location:', JSON.stringify(activeLoc.currentLocation));

    if (activeLoc.coordinates && activeLoc.coordinates.length > 0) {
      console.log('\n--- FIRST 3 COORDINATES ---');
      console.log(JSON.stringify(activeLoc.coordinates.slice(0, 3), null, 2));
      console.log('\n--- LAST 5 COORDINATES ---');
      console.log(JSON.stringify(activeLoc.coordinates.slice(-5), null, 2));
    }

    const pointsCount = await TrackingPoint.countDocuments({ sessionId: activeLoc._id });
    console.log('\nTrackingPoint DB documents count:', pointsCount);

    if (pointsCount > 0) {
      const points = await TrackingPoint.find({ sessionId: activeLoc._id }).sort({ timestamp: -1 }).limit(5);
      console.log('\n--- LATEST 5 TRACKING POINTS FROM DB ---');
      console.log(JSON.stringify(points, null, 2));
    }

    const ledgers = await DistanceLedger.find({ sessionId: activeLoc._id }).sort({ createdAt: -1 }).limit(10);
    console.log('\n--- DISTANCE LEDGER ENTRIES ---');
    console.log(JSON.stringify(ledgers, null, 2));
  }

  process.exit(0);
}

checkSaifuddin().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
