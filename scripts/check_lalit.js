const mongoose = require('mongoose');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.collection('users');
  const lalit = await users.findOne({ name: /lalit/i });
  const rawAssignedIds = (lalit.assignedEmployees || []).map(e => (e && e._id) ? e._id : e).filter(Boolean);
  console.log('Extracted IDs count for Lalit:', rawAssignedIds.length);
  const matched = await users.find({ _id: { $in: rawAssignedIds } }).toArray();
  console.log('Matched employees for Lalit:', matched.map(m => ({ name: m.name, empId: m.employeeId })));

  const ajay = await users.findOne({ name: /ajay.*pathak/i });
  const ajayEmps = await users.find({ manager: ajay._id }).toArray();
  console.log('Matched employees for Ajay:', ajayEmps.map(m => ({ name: m.name, empId: m.employeeId })));

  await mongoose.disconnect();
}
check().catch(console.error);
