const cron = require('node-cron');
const { Notification } = require('../models');
const { autoStopInactiveSessions, reconcileAllActiveSessions } = require('../controllers/tracking.controller');

/**
 * Initializes all background cron jobs.
 * @param {Object} io - Socket.io instance for emitting real-time events
 */
const initCronJobs = (io) => {
  // ─── Continuous Background Reconciliation Worker ─────────────────────────
  // Scans active sessions every 5 minutes to repair any KM discrepancies/unprocessed points in MongoDB
  cron.schedule('*/5 * * * *', async () => {
    try {
      if (typeof reconcileAllActiveSessions === 'function') {
        await reconcileAllActiveSessions();
      }
    } catch (error) {
      console.error('❌ [CRON] Error running background session reconciliation:', error.message);
    }
  });

  // Run at minute 0 past every hour: '0 * * * *'
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('⏳ [CRON] Running hourly pending notification check...');
      
      // Auto-cleanup legacy auto-stop notifications so old DB entries don't trigger reminders
      await Notification.updateMany(
        { 
          $or: [
            { title: /Tracking stopped automatically/i },
            { message: /without accepted GPS movement/i }
          ],
          isRead: false 
        },
        { $set: { isRead: true } }
      ).catch(() => {});

      // Find all unread notifications grouped by recipient
      const unreadStats = await Notification.aggregate([
        { $match: { isRead: false } },
        { $group: { _id: '$recipient', count: { $sum: 1 } } }
      ]);

      if (unreadStats.length === 0) {
        console.log('✅ [CRON] No pending notifications found.');
        return;
      }

      // Hourly notification reminder socket emission disabled to prevent spamming phone notifications.
      // Notifications remain accessible in the app's notification center.
      console.log(`[CRON] Pending notifications check completed for ${unreadStats.length} users.`);
    } catch (error) {
      console.error('❌ [CRON] Error running pending notification check:', error.message);
    }
  });
};

module.exports = {
  initCronJobs
};
