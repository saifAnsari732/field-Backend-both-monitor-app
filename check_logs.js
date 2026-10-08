const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, User, ActivityLog } = require('./models');

async function checkLogs() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';
    await mongoose.connect(uri);
    
    const logs = await ActivityLog.find({
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    }).sort({ createdAt: -1 }).populate('employee', 'name');
    
    console.log('Recent Activity Logs (Last 1 hour):');
    for (const l of logs) {
      console.log(`[${l.createdAt.toISOString()}] User: ${l.employee?.name} | Action: ${l.action} | Desc: ${l.description}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
checkLogs();
