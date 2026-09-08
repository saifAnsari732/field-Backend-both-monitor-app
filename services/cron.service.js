const cron = require('node-cron');
const { Notification } = require('../models');
const { autoStopInactiveSessions } = require('../controllers/tracking.controller');

/**
 * Initializes all background cron jobs.
 * @param {Object} io - Socket.io instance for emitting real-time events
 */
const initCronJobs = (io) => {
  // Run every five minutes so a stale shift is closed shortly after its 1-hour deadline.
  cron.schedule('*/5 * * * *', async () => {
    try {
      await autoStopInactiveSessions(io);
    } catch (error) {
      console.error('❌ [CRON] Error auto-stopping inactive tracking:', error.message);
    }
  });

  // Run at minute 0 past every hour: '0 * * * *'
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('⏳ [CRON] Running hourly pending notification check...');
      
      // Find all unread notifications grouped by recipient
      const unreadStats = await Notification.aggregate([
        { $match: { isRead: false } },
        { $group: { _id: '$recipient', count: { $sum: 1 } } }
      ]);

      if (unreadStats.length === 0) {
        console.log('✅ [CRON] No pending notifications found.');
        return;
      }

      console.log(`[CRON] Found ${unreadStats.length} employees with pending notifications.`);

      unreadStats.forEach(stat => {
        const employeeId = stat._id.toString();
        const unreadCount = stat.count;

        // Emit a reminder notification over Socket.io to the specific employee
        io.to(employeeId).emit('notification', {
          _id: `reminder_${Date.now()}_${Math.random()}`,
          title: 'Unread Notifications Reminder',
          message: `You have ${unreadCount} pending notification(s). Please review them.`,
          type: 'alert',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      });

      console.log('✅ [CRON] Hourly reminder notifications sent successfully.');
    } catch (error) {
      console.error('❌ [CRON] Error running pending notification check:', error.message);
    }
  });
};

module.exports = {
  initCronJobs
};
