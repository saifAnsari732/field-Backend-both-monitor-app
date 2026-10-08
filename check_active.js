const mongoose = require('mongoose');
require('dotenv').config();
const { LiveLocation, User } = require('./models');

async function check() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';
    await mongoose.connect(uri);
    console.log('Connected to DB');
    const today = new Date().toISOString().slice(0, 10);
    const users = await User.find({
      name: { $regex: /ritesh|lalit|saif|ankit|indresh|prabhakar/i }
    });
    
    for (const u of users) {
      const activeSession = await LiveLocation.findOne({ employee: u._id, isActive: true });
      const allTodaySessions = await LiveLocation.find({ employee: u._id, date: today }).sort({ createdAt: -1 });
      console.log('====================================================');
      console.log('User:', u.name, 'ID:', String(u._id), 'isTracking:', u.isTracking, 'isOnline:', u.isOnline);
      console.log('Active Session:', activeSession ? {
        sessionId: activeSession.sessionId,
        isActive: activeSession.isActive,
        totalDistance: activeSession.totalDistance,
        lastActivity: activeSession.lastActivity,
        updatedAt: activeSession.updatedAt,
        coordsCount: activeSession.coordinates?.length || 0,
        lastCoord: activeSession.coordinates?.length > 0 ? activeSession.coordinates[activeSession.coordinates.length - 1] : null
      } : 'NONE');
      console.log('Total Sessions Today:', allTodaySessions.length);
      if (allTodaySessions.length > 0 && !activeSession) {
        console.log('Latest Closed Session:', {
          sessionId: allTodaySessions[0].sessionId,
          isActive: allTodaySessions[0].isActive,
          totalDistance: allTodaySessions[0].totalDistance,
          endTime: allTodaySessions[0].endTime,
          updatedAt: allTodaySessions[0].updatedAt,
          coordsCount: allTodaySessions[0].coordinates?.length || 0
        });
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}
check();
