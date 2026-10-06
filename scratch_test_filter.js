const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function testFilter() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sessionId: String,
    isActive: Boolean,
    date: String,
    totalDistance: Number,
    createdAt: Date,
    organizationId: mongoose.Schema.Types.ObjectId
  }), 'livelocations');

  const User = mongoose.model('User', new mongoose.Schema({ name: String, organizationId: mongoose.Schema.Types.ObjectId }), 'users');

  const date = '2026-10-06';
  const filter = {
    $or: [{ date: date }, { isActive: true }]
  };

  const results = await LiveLocation.find(filter)
    .populate('employee', 'name')
    .sort({ createdAt: -1 });

  console.log(`Total records returned: ${results.length}`);
  results.forEach(r => {
    console.log(`- Employee: ${r.employee?.name} (${r.employee?._id}), sessionId: ${r.sessionId}, date: ${r.date}, isActive: ${r.isActive}, dist: ${r.totalDistance}km, createdAt: ${r.createdAt}`);
  });

  await mongoose.disconnect();
}

testFilter().catch(console.error);
