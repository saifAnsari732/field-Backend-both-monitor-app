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

// df Trust the reverse proxy (like Nginx/MilesWeb) to properly pass client IPs for rate-limiting
app.set('trust proxy', 1);

const server = http.createServer(app);

// Keep REST and Socket.IO on the same allow-list so browser preflight behaves consistently.
const allowedOrigins = new Set([
  'https://kisanteamapp.online',
  'https://www.kisanteamapp.online',
  'https://tm24news.com',
  'https://www.tm24news.com',
  'https://kisanteamweb.it.com',
  'https://tm-24news.vercel.app',
  'https://tm24news.vercel.app',
  'http://localhost:3000', 
  'http://localhost:8081',
  'http://127.0.0.1:8081', 
  'http://192.168.0.110:8081',
  'http://192.168.0.107:8081', 
  'http://localhost:19006',
  ...(process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // Mobile apps (Expo Go, React Native), curl, Postman
  if (allowedOrigins.has(origin)) return true;
  if (
    origin.endsWith('.kisanteamapp.online') ||
    origin.endsWith('.tm24news.com') ||
    origin.endsWith('.vercel.app') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes('192.168.')
  ) {
    return true;
  }
  return false;
};

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
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
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint (placed BEFORE rate limiter so uptime monitors and CI/CD never get blocked)
app.get('/api/health', (req, res) => res.json({ status: '3 OK AWS Working CI-CD Live Test', timestamp: new Date() }));

// Rate limitingertbetbfghmfh
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // relaxed limit for multi-device offices and NAT gateways
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path.startsWith('/tracking'),
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
const { protect } = require('./middleware/auth.middleware');
const { LiveLocation, Meeting } = require('./models');

// Dashboard stats route for employee
app.get('/api/dashboard/stats', protect, async (req, res) => {
  try {
    const todayDateObj = new Date();
    todayDateObj.setHours(0, 0, 0, 0);
    
    const year = todayDateObj.getFullYear();
    const month = String(todayDateObj.getMonth() + 1).padStart(2, '0');
    const day = String(todayDateObj.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // Get all tracking sessions
    const allSessions = await LiveLocation.find({ employee: req.user._id });
    const totalDistanceAllDates = allSessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);
    
    // Today's sessions
    const todaySessions = allSessions.filter(s => s.date === dateStr);
    const distanceToday = todaySessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0);

    // Today's meetings
    const meetingCount = await Meeting.countDocuments({ 
      employee: req.user._id, 
      date: { $gte: todayDateObj } 
    });

    res.json({
      success: true,
      stats: {
        distanceToday: distanceToday.toFixed(2),
        totalDistanceAllDates: totalDistanceAllDates.toFixed(2),
        meetingCount,
        travelRate: req.user.TA || req.user.travelRate || 0,
        todayAttendance: { status: 'present' },
        monthlyAttendance: { present: 20, absent: 2, leave: 1 },
        totalExpenses: 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
app.use('/api/leads', require('./routes/lead.routes'));
//  news api
app.use('/api', require('./routes/newsRouts'));

// Gemini Integration (Moved from test-gemini.js)
app.post('/api/gemini/generate', async (req, res) => {   
  try { 
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: 'Prompt is required' });

    // Using the key from the test script. Ideally, move this to .env (GEMINI_API_KEY) in the future.
    const API_KEY = process.env.GEMINI_API_KEY;
    
    // NOTE: Using native fetch from Node 18+ (since we use node-fetch or native fetch)
    const fetch = require('node-fetch'); // Ensure fetch is available if older node
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    const data = await response.json();
    res.json({ success: true, status: response.status, data });
  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Socket.IO Logic
const socketHandler = require('./socket/socket.handler');
socketHandler(io);

// Initialize Background Cron Jobs
const { initCronJobs } = require('./services/cron.service');
initCronJobs(io);

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
    