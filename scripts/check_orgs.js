require('dotenv').config();
const mongoose = require('mongoose');

async function checkOrgs() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = await db.collection('users').find({}).toArray();
  console.log(`Total users in DB: ${users.length}`);

  for (const u of users) {
    if (u.role && u.role.toLowerCase().includes('admin') || u.role && u.role.toLowerCase().includes('manager')) {
      console.log(`ADMIN/MGR: ${u.name} (${u.employeeId || u.phone}), role: ${u.role}, org: ${u.organizationId}`);
    }
  }

  console.log('\n--- ALL EMPLOYEES & THEIR ORG ---');
  for (const u of users) {
    if (!u.role || u.role === 'employee') {
      console.log(`EMP: ${u.name} (${u.employeeId || u.phone}), isTracking: ${u.isTracking}, org: ${u.organizationId}`);
    }
  }

  await mongoose.disconnect();
}

checkOrgs().catch(console.error);
