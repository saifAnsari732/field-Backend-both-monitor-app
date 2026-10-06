const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

async function checkRajesh() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const User = mongoose.model('User', new mongoose.Schema({ name: String, role: String, organizationId: mongoose.Schema.Types.ObjectId }), 'users');
  const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({ 
    employee: mongoose.Schema.Types.ObjectId, 
    sessionId: String,
    isActive: Boolean, 
    createdAt: Date, 
    updatedAt: Date, 
    date: String, 
    totalDistance: Number,
    lastActivity: Date,
    autoClosed: Boolean
  }), 'livelocations');
  const Attendance = mongoose.model('Attendance', new mongoose.Schema({ 
    employee: mongoose.Schema.Types.ObjectId, 
    date: String, 
    status: String, 
    punchInTime: Date, 
    punchOutTime: Date 
  }), 'attendances');

  const rajeshList = await User.find({ name: { $regex: /rajesh/i } });
  console.log('Rajesh users found:', rajeshList.map(u => ({ id: u._id, name: u.name, role: u.role, org: u.organizationId })));

  for (const r of rajeshList) {
    const liveLocs = await LiveLocation.find({ employee: r._id }).sort({ createdAt: -1 }).limit(10);
    console.log(`LiveLocations for ${r.name} (${r._id}):`);
    liveLocs.forEach(l => {
      console.log(` - Session ${l.sessionId}: date=${l.date}, isActive=${l.isActive}, autoClosed=${l.autoClosed}, dist=${l.totalDistance}km, createdAt=${l.createdAt?.toISOString()}, lastActivity=${l.lastActivity?.toISOString()}`);
    });

    const attendances = await Attendance.find({ employee: r._id }).sort({ date: -1 }).limit(5);
    console.log(`Attendances for ${r.name} (${r._id}):`);
    attendances.forEach(a => {
      console.log(` - Date=${a.date}, status=${a.status}, punchIn=${a.punchInTime?.toISOString()}, punchOut=${a.punchOutTime?.toISOString()}`);
    });
  }

  await mongoose.disconnect();
}

checkRajesh().catch(console.error);
