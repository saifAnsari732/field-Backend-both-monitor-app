require('dotenv').config();
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

async function testSocket() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const admin = await db.collection('users').findOne({ role: { $in: ['admin', 'ADMIN', 'super_admin', 'SUPER_ADMIN'] } });
  console.log('Found admin user for socket auth:', admin?.name, admin?._id);

  const token = jwt.sign(
    { id: admin._id, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const port = 5001;
  console.log(`Connecting socket to http://localhost:${port}...`);
  const socket = ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ['websocket', 'polling']
  });

  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log('✅ Connected to Socket.IO server as', socket.id);
      resolve();
    });
    socket.on('connect_error', (err) => {
      console.error('❌ Socket connect error:', err.message);
      reject(err);
    });
  });

  socket.disconnect();
  await mongoose.disconnect();
}

testSocket().catch(console.error);
