const mongoose = require('I:/field-web-monitoring/field-monitoe-BACK/node_modules/mongoose');
require('dotenv').config({ path: 'I:/field-web-monitoring/field-monitoe-BACK/.env' });

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const trackingController = require('I:/field-web-monitoring/field-monitoe-BACK/controllers/tracking.controller.js');
  const User = require('I:/field-web-monitoring/field-monitoe-BACK/models/User.model.js');

  const superAdmin = await User.findOne({ role: { $in: ['admin', 'super_admin', 'superadmin', 'SUPER_ADMIN'] } });
  console.log('Using SuperAdmin:', superAdmin?.name, superAdmin?.email);

  const req = {
    user: superAdmin
  };

  let responseData = null;
  const res = {
    json: (data) => {
      responseData = data;
    },
    status: (code) => {
      return {
        json: (data) => {
          responseData = { statusCode: code, ...data };
        }
      };
    }
  };

  await trackingController.getLiveEmployees(req, res);

  console.log('\n--- LIVE EMPLOYEES RESPONSE SUMMARY ---');
  console.log('Total Locations returned:', responseData?.locations?.length);
  console.log('Total Employees returned:', responseData?.employees?.length);

  for (const loc of responseData?.locations || []) {
    const emp = loc.employee;
    const empUser = (responseData?.employees || []).find(e => String(e._id) === String(emp?._id || emp));
    console.log(
      (emp?.name || 'Unknown').padEnd(20),
      '| isActive:', String(loc.isActive).padEnd(6),
      '| isTracking:', String(empUser?.isTracking).padEnd(6),
      '| KM:', String(loc.totalDistance).padEnd(7),
      '| coords:', String(loc.coordinates?.length || 0).padEnd(5)
    );
  }

  await mongoose.disconnect();
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
