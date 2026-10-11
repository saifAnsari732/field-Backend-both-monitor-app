const mongoose = require('mongoose');
const URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function run() {
  await mongoose.connect(URI);
  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({}, { strict: false }));
  const sessions = await LiveLocation.find({ employee: new mongoose.Types.ObjectId('6aca1db9fe7c5a1fbc5b1160') }).lean();
  console.log('ALL SESSIONS COUNT:', sessions.length);
  sessions.forEach((s, idx) => {
    console.log('=== SESSION ' + (idx + 1) + ' ===');
    console.log('_id:', s._id);
    console.log('sessionId:', s.sessionId);
    console.log('date:', s.date);
    console.log('createdAt:', s.createdAt);
    console.log('startTime:', s.startTime);
    console.log('endTime:', s.endTime);
    console.log('isActive:', s.isActive);
    console.log('totalDistance:', s.totalDistance);
    console.log('coordinates length:', (s.coordinates || []).length);
  });

  const DistanceLedger = mongoose.model('DistanceLedger', new mongoose.Schema({}, { strict: false }));
  const ledgers = await DistanceLedger.find({ employeeId: new mongoose.Types.ObjectId('6aca1db9fe7c5a1fbc5b1160') }).lean();
  console.log('DISTANCE LEDGER COUNT:', ledgers.length);
  const ledgerBySession = {};
  ledgers.forEach(l => {
    ledgerBySession[l.sessionId] = (ledgerBySession[l.sessionId] || 0) + (l.distanceKm || 0);
  });
  console.log('DistanceLedger KM by sessionId:', ledgerBySession);

  process.exit(0);
}
run();
