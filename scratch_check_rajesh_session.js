const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function checkRajeshSession() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({
    sessionId: String,
    isActive: Boolean,
    coordinates: Array,
    totalDistance: Number,
    date: String
  }), 'livelocations');

  const DistanceLedger = mongoose.model('DistanceLedger', new mongoose.Schema({
    sessionId: String,
    distanceKm: Number,
    toTimestamp: Date,
    classification: String
  }), 'distanceledgers');

  const session = await LiveLocation.findOne({ sessionId: 'bbd9b7a7-eaa0-42e3-901f-10e2dde3aae8' });
  if (session) {
    console.log(`Session ${session.sessionId}: totalCoords=${session.coordinates?.length}, totalDist=${session.totalDistance}km`);
    if (session.coordinates && session.coordinates.length > 0) {
      console.log('First coord:', session.coordinates[0]);
      console.log('Last coord:', session.coordinates[session.coordinates.length - 1]);
      
      const todayCoords = session.coordinates.filter(c => {
        const d = new Date(c.timestamp || c.createdAt);
        return d >= new Date('2026-10-06T00:00:00.000Z') && d <= new Date('2026-10-06T23:59:59.999Z');
      });
      console.log(`Today (2026-10-06) coordinates count: ${todayCoords.length}`);
    }
  }

  const ledgers = await DistanceLedger.find({ sessionId: 'bbd9b7a7-eaa0-42e3-901f-10e2dde3aae8' });
  console.log(`DistanceLedger count for session: ${ledgers.length}`);
  const todayLedgers = ledgers.filter(l => l.toTimestamp >= new Date('2026-10-06T00:00:00.000Z'));
  console.log(`Today (2026-10-06) ledgers count: ${todayLedgers.length}`);

  await mongoose.disconnect();
}

checkRajeshSession().catch(console.error);
