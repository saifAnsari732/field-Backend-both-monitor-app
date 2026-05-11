const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    // origin: process.env.CLIENT_URL,
    origin: "*",
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", process.env.CLIENT_URL].filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/employees', require('./routes/employee.routes'));
app.use('/api/tracking', require('./routes/tracking.routes'));
app.use('/api/meetings', require('./routes/meeting.routes'));
app.use('/api/expenses', require('./routes/expense.routes'));
app.use('/api/attendance', require('./routes/attendance.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/upload', require('./routes/upload.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));

// Socket.IO Logic
const socketHandler = require('./socket/socket.handler');
socketHandler(io);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm_tracker')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = { app, server, io };
