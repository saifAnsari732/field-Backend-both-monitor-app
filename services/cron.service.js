const cron = require('node-cron');
const { Notification, LiveLocation, User } = require('../models');
const { reconcileAllActiveSessions } = require('../controllers/tracking.controller');
const { deleteCacheByPrefix } = require('./cache.service');

function getBusinessDate(date = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

/**
 * Initializes all background cron jobs.
 * @param {Object} io - Socket.io instance for emitting real-time events
 */
const initCronJobs = (io) => {
  // ── 1-Day Boundary Rollover & Midnight Reset (Daily at 00:00:00 Asia/Kolkata) ──
  // User Rule: "only 1 day baad km reset hoga"
  cron.schedule('0 0 * * *', async () => {
    try {
      const yesterday = getBusinessDate(new Date(Date.now() - 24 * 60 * 60 * 1000), 'Asia/Kolkata');
      const today = getBusinessDate(new Date(), 'Asia/Kolkata');
      console.log(`🌙 [MIDNIGHT_CRON] Executing 1-Day KM Boundary Rollover from ${yesterday} to ${today}...`);

      // 1. Gracefully close any leftover unclosed sessions from yesterday
      const staleActiveSessions = await LiveLocation.find({
        isActive: true,
        date: { $ne: today }
      });

      for (const s of staleActiveSessions) {
        await LiveLocation.findByIdAndUpdate(s._id, {
          isActive: false,
          endTime: s.endTime || new Date(),
          autoClosed: false,
          manuallyStopped: false
        }).catch(() => {});
      }

      // 2. Reset User.totalDistanceToday to 0 for the fresh new day
      await User.updateMany(
        {},
        { $set: { totalDistanceToday: 0, distanceTodayDate: today, isTracking: false } }
      ).catch(() => {});

      // 3. Clear all caches so UI and mobile apps start with 0.00 km for the new day
      if (typeof deleteCacheByPrefix === 'function') {
        await Promise.all([
          deleteCacheByPrefix('live_locations_'),
          deleteCacheByPrefix('admin_employees_'),
          deleteCacheByPrefix('admin_dashboard_stats_')
        ]).catch(() => {});
      }

      if (io) {
        io.emit('daily_midnight_reset', { date: today });
      }
      console.log(`✅ [MIDNIGHT_CRON] 1-Day Rollover completed. All KM initialized to 0 for ${today}.`);
    } catch (err) {
      console.error('❌ [MIDNIGHT_CRON] Error during midnight rollover:', err);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // ─── Continuous Background Autonomous Sentinel Worker (Runs Every 1 Min) ──
  // Reverses any legacy TRACKING_AUTO_STOPPED closures & reconciles KM discrepancies in MongoDB
  cron.schedule('* * * * *', async () => {
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
