const jwt = require('jsonwebtoken');
const axios = require('axios');
const mongoose = require('I:/field-web-monitoring/field-monitoe-BACK/node_modules/mongoose');
require('dotenv').config({ path: 'I:/field-web-monitoring/field-monitoe-BACK/.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('I:/field-web-monitoring/field-monitoe-BACK/models/User.model.js');
  const superAdmin = await User.findOne({ role: { $in: ['admin', 'super_admin', 'superadmin', 'SUPER_ADMIN'] } });
  const token = jwt.sign({ id: superAdmin._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
  
  const res = await axios.get('http://localhost:5001/api/tracking/live', {
    headers: { Authorization: 'Bearer ' + token }
  });
  console.log('HTTP Status:', res.status, 'Locations Count:', res.data.locations?.length);
  const ankit = res.data.locations.find(l => l.employee?.name?.toLowerCase().includes('ankit'));
  const rajesh = res.data.locations.find(l => l.employee?.name?.toLowerCase().includes('rajesh'));
  console.log('Ankit in HTTP response:', { name: ankit?.employee?.name, isActive: ankit?.isActive, KM: ankit?.totalDistance });
  console.log('Rajesh in HTTP response:', { name: rajesh?.employee?.name, isActive: rajesh?.isActive, KM: rajesh?.totalDistance });

  const ankitEmp = res.data.employees.find(e => e.name?.toLowerCase().includes('ankit'));
  const rajeshEmp = res.data.employees.find(e => e.name?.toLowerCase().includes('rajesh'));
  console.log('Ankit employee object:', { name: ankitEmp?.name, isTracking: ankitEmp?.isTracking, isOnline: ankitEmp?.isOnline });
  console.log('Rajesh employee object:', { name: rajeshEmp?.name, isTracking: rajeshEmp?.isTracking, isOnline: rajeshEmp?.isOnline });

  await mongoose.disconnect();
}
check().catch(console.error);
