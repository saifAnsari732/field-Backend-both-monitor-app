require('dotenv').config();
const mongoose = require('mongoose');

async function f() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const a = await db.collection('attendances').find({
    employee: { $in: [new mongoose.Types.ObjectId('6aa29484121f6a98ffd097c1'), new mongoose.Types.ObjectId('6abe6130d0c4045c810613c6')] }
  }).sort({ createdAt: -1 }).limit(10).toArray();

  for (const doc of a) {
    console.log(`Attendance _id: ${doc._id}, employee: ${doc.employee}, date type: ${typeof doc.date}, date val: ${doc.date}, totalDistanceTraveled: ${doc.totalDistanceTraveled}`);
  }
  await mongoose.disconnect();
}
f().catch(console.error);
