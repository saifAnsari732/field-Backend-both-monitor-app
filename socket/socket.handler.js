const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const HEARTBEAT_TIMEOUT = 60000; // 60 seconds
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
    console.log(`🔌 ${user.name} connected [${user.role}] - ${socket.id}`);

    // Update user socket ID and online status
    await User.findByIdAndUpdate(user._id, { socketId: socket.id, isOnline: true });

    // Join role-based rooms
    if (user.role === 'admin' || user.role === 'hr') {
      socket.join('admins');
      // Send current online employees to admin
      const onlineEmployees = await User.find({ isOnline: true, role: 'employee' })
        .select('name employeeId isTracking isOnline lastSeen avatar department');
      socket.emit('online_employees', onlineEmployees);
    }
    socket.join(`user_${user._id}`);

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
      // Reset heartbeat timeout on client heartbeat
      setupHeartbeatTimeout();
      socket.emit('heartbeat_ack', { timestamp: Date.now() });
    });

    setupHeartbeatTimeout();

    // ─── Tracking Events ────────────────────────────────────────────────────────
    socket.on('location_ping', async (data) => {
      // Real-time location broadcast to admins
      io.to('admins').emit('employee_location', {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        department: user.department,
        ...data,
      });
    });

    socket.on('tracking_started', (data) => {
      io.to('admins').emit('employee_tracking_started', {
        employeeId: user._id,
        name: user.name,
        avatar: user.avatar,
        ...data,
      });
    });

    socket.on('tracking_stopped', (data) => {
      io.to('admins').emit('employee_tracking_stopped', {
        employeeId: user._id,
        name: user.name,
        ...data,
      });
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
