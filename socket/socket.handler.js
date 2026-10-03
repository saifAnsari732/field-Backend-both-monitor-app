const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const HEARTBEAT_TIMEOUT = 180000; // 180 seconds (3 minutes — prevents disconnect when browser tab is inactive)
const heartbeatTimers = new Map(); // Track heartbeat timers per socket

module.exports = (io) => {
  // Auth middleware for socket
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication error'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (!user) return next(new Error('User not found'));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    const normalizedRole = (user.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(normalizedRole);
    const orgId = user.organizationId?._id || user.organizationId;
    const orgRoom = orgId ? `org_${orgId}` : null;
    const adminOrgRoom = orgId ? `org_admins_${orgId}` : null;

    console.log(`🔌 ${user.name} connected [${user.role}] (Org: ${orgId || 'N/A'}) - ${socket.id}`);

    // Update user socket ID and online status
    await User.findByIdAndUpdate(user._id, { socketId: socket.id, isOnline: true });

    // Join user & organization rooms
    socket.join(`user_${user._id}`);
    socket.join(String(user._id));

    if (isSuperAdmin) {
      socket.join('superadmins');
      socket.join('admins');
    }

    if (orgRoom) {
      socket.join(orgRoom);
      socket.join(`org:${orgId}`);
      if (['ORG_ADMIN', 'ORGADMIN', 'ADMIN', 'HR', 'MANAGER'].includes(normalizedRole)) {
        socket.join(adminOrgRoom);
        socket.join(`org:${orgId}:admins`);
      }
    }

    // Legacy admin room with org scoping
    if (['ADMIN', 'ORG_ADMIN', 'ORGADMIN', 'HR', 'MANAGER'].includes(normalizedRole)) {
      socket.join('admins');
      const onlineEmployees = await User.find({
        isOnline: true,
        role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] },
        ...(isSuperAdmin ? {} : { organizationId: orgId }),
      }).select('name employeeId isTracking isOnline lastSeen avatar department organizationId');
      socket.emit('online_employees', onlineEmployees);
    }

    // ─── Heartbeat Mechanism ────────────────────────────────────────────────────
    const setupHeartbeatTimeout = () => {
      if (heartbeatTimers.has(socket.id)) {
        clearTimeout(heartbeatTimers.get(socket.id));
      }

      const timer = setTimeout(() => {
        console.log(`⏱️ Heartbeat timeout for ${user.name}, disconnecting...`);
        socket.disconnect(true);
      }, HEARTBEAT_TIMEOUT);

      heartbeatTimers.set(socket.id, timer);
    };

    socket.on('heartbeat', (data) => {
      setupHeartbeatTimeout();
      socket.emit('heartbeat_ack', { timestamp: Date.now() });
    });

    setupHeartbeatTimeout();

    // ─── Tracking Events (Scoped by Org Room) ──────────────────────────────────
    socket.on('location_ping', async (data) => {
      const payload = {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        department: user.department,
        organizationId: user.organizationId,
        ...data,
      };

      if (adminOrgRoom) {
        io.to(adminOrgRoom).to(`org:${orgId}:admins`).to('superadmins').emit('employee_location', payload);
      } else {
        io.to('admins').emit('employee_location', payload);
      }
    });

    socket.on('tracking_started', (data) => {
      const payload = {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        organizationId: user.organizationId,
        ...data,
      };

      if (adminOrgRoom) {
        io.to(adminOrgRoom).to(`org:${orgId}:admins`).to('superadmins').emit('employee_tracking_started', payload);
      } else {
        io.to('admins').emit('employee_tracking_started', payload);
      }
    });

    socket.on('tracking_stopped', (data) => {
      const payload = {
        employeeId: user._id,
        name: user.name,
        organizationId: user.organizationId,
        ...data,
      };

      if (adminOrgRoom) {
        io.to(adminOrgRoom).to(`org:${orgId}:admins`).to('superadmins').emit('employee_tracking_stopped', payload);
      } else {
        io.to('admins').emit('employee_tracking_stopped', payload);
      }
    });

    // ─── Chat / Notifications ────────────────────────────────────────────────────
    socket.on('send_notification', async (data) => {
      const { recipientId, title, message, type } = data;
      io.to(`user_${recipientId}`).emit('notification', {
        title,
        message,
        type,
        from: user.name,
      });
    });

    socket.on('admin_alert', (data) => {
      io.to(`user_${data.employeeId}`).emit('alert', {
        message: data.message,
        from: 'Admin',
      });
    });

    // ─── Disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`🔌 ${user.name} disconnected`);

      // Clear heartbeat timer
      if (heartbeatTimers.has(socket.id)) {
        clearTimeout(heartbeatTimers.get(socket.id));
        heartbeatTimers.delete(socket.id);
      }

      await User.findByIdAndUpdate(user._id, {
        isOnline: false,
        lastSeen: new Date(),
        socketId: null,
      });

      io.to('admins').emit('employee_offline', {
        employeeId: user._id,
        name: user.name,
      });
    });

    // ─── Error Handling ─────────────────────────────────────────────────────────
    socket.on('error', (error) => {
      console.error(`Socket error for ${user.name}:`, error);
    });

    // Confirm connection to client
    socket.emit('connected', {
      message: 'Connected to server',
      userId: user._id,
      timestamp: Date.now(),
    });
  });

  // Cleanup on server shutdown
  io.on('disconnect', (socket) => {
    if (heartbeatTimers.has(socket.id)) {
      clearTimeout(heartbeatTimers.get(socket.id));
      heartbeatTimers.delete(socket.id);
    }
  });
};
