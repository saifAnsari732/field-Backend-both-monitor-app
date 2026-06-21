const express = require('express');

// 🛡️ Global Crash Protection to prevent server from shutting down on MilesWeb
process.on('uncaughtException', (err) => {
  console.error('🔥 CRITICAL: Uncaught Exception caught to prevent crash:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 CRITICAL: Unhandled Rejection caught to prevent crash. Reason:', reason);
});

const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Allowed origins list for CORS
const allowedOrigins = [
  'https://tm24news.com',
  "http://localhost:8002",
  'https://www.tm24news.com',
  'https://kisanteamweb.it.com',
  'https://tm-24news.vercel.app',
  'https://tm24news.vercel.app'
];

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or postman)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: false, // Required for cross-origin images/resources
}));
app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false, 
});
app.use('/api/', limiter);

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
app.use('/api/leaves', require('./routes/leave.routes'));
app.use('/api/tasks', require('./routes/task.routes'));
// Mock dashboard route since local backend is missing dashboard.routes.js

app.get('/api/dashboard/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      todayAttendance: { status: 'present' },
      monthlyAttendance: { present: 20, absent: 2, leave: 1 },
      totalExpenses: 500,
      completedMeetings: 10
    }
  });
});
app.use('/api/leads', require('./routes/lead.routes'));
//  news api
app.use('/api', require('./routes/newsRouts'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));

// Socket.IO Logic
const socketHandler = require('./socket/socket.handler');
socketHandler(io);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/')
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
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = { app, server, io };
