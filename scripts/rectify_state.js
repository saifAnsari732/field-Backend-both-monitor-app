require('dotenv').config();
const mongoose = require('mongoose');
const Redis = require('ioredis');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function rectify() {
  console.log('🚀 Starting Database & Redis State Rectifier for Rajesh Kumar & Indresh Kumar...');
  
  // 1. Connect to MongoDB Atlas
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI not found in environment');
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  console.log('✅ Connected to MongoDB Atlas');

  // 2. Connect to Upstash Redis
  const rawRedisUrl = (process.env.REDIS_URL || '').trim().replace(/^["']|["']$/g, '');
  let redis = null;
  if (rawRedisUrl) {
    redis = new Redis(rawRedisUrl);
    await new Promise((resolve, reject) => {
      redis.on('ready', () => {
        console.log('✅ Connected to Upstash Redis (TCP)');
        resolve();
      });
      redis.on('error', (err) => {
        console.warn('⚠️ Redis error:', err.message);
        resolve(); // Continue even if Redis TCP has issue
      });
    });
  }

  // 3. Find target employees: Rajesh Kumar (EMP-6FD8C90E) and Indresh Kumar
  const targetUsers = await db.collection('users').find({
    $or: [
      { employeeId: 'EMP-6FD8C90E' },
      { name: { $regex: 'Rajesh', $options: 'i' } },
      { name: { $regex: 'Indresh', $options: 'i' } }
    ]
  }).toArray();

  console.log(`\nFound ${targetUsers.length} employee target(s):`);
  targetUsers.forEach(u => console.log(`  - ${u.name} (${u.employeeId}, _id: ${u._id})`));

  const results = [];
  const targetDate = '2026-10-15';

  for (const user of targetUsers) {
    console.log(`\n===============================================================`);
    console.log(`Processing: ${user.name} (${user.employeeId}, ID: ${user._id})`);

    // Find all sessions for today
    const sessions = await db.collection('livelocations').find({
      employee: user._id,
      date: targetDate
    }).toArray();

    console.log(`Found ${sessions.length} session(s) today for ${user.name}:`);

    let employeeCumulativeCleanKm = 0;

    for (const s of sessions) {
      console.log(`\n--- Session: ${s.sessionId} ---`);
      console.log(`  Current liveLocation totalDistance: ${s.totalDistance} km, officialDistance: ${s.officialDistance} km`);

      // 4a. DistanceLedger Inspection & Rejection
      const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
      let bogusCount = 0;
      let bogusDistanceKm = 0;

      for (const l of ledgers) {
        const isSync = (l.toEventId && l.toEventId.includes(':sync:')) || 
                       (l.fromEventId && l.fromEventId.includes(':sync:')) ||
                       l.reason === 'AGTRIE_X_SCREEN_TELEMETRY_SYNC';

        const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
        const speedKmh = (l.distanceKm / (dtSec / 3600));
        const isSupersonic = speedKmh > 150.0 && l.distanceKm > 1.5;

        if ((isSync || isSupersonic) && l.classification !== 'REJECTED') {
          bogusCount++;
          bogusDistanceKm += l.distanceKm;
          await db.collection('distanceledgers').updateOne(
            { _id: l._id },
            { 
              $set: { 
                classification: 'REJECTED', 
                reason: isSync ? 'BOGUS_SYNC_REJECTED' : 'BOGUS_SUPERSONIC_JUMP_REJECTED' 
              } 
            }
          );
        }
      }

      console.log(`  DistanceLedgers: Marked ${bogusCount} bogus ledgers as REJECTED (totaling ${bogusDistanceKm.toFixed(2)} km)`);

      // 4b. Sum remaining ACCEPTED + RECOVERED ledgers (excluding fake screen sync)
      const cleanLedgerAgg = await db.collection('distanceledgers').aggregate([
        { 
          $match: { 
            sessionId: s.sessionId, 
            classification: { $in: ['ACCEPTED', 'RECOVERED'] },
            reason: { $ne: 'AGTRIE_X_SCREEN_TELEMETRY_SYNC' }
          } 
        },
        { $group: { _id: null, total: { $sum: '$distanceKm' } } }
      ]).toArray();

      const cleanKm = Math.round((cleanLedgerAgg[0]?.total || 0) * 100) / 100;
      employeeCumulativeCleanKm += cleanKm;
      console.log(`  Authoritative clean road distance (ACCEPTED + RECOVERED): ${cleanKm} km`);

      // 4c. Filter coordinates array to remove ALL points with :sync: or extreme supersonic jumps (>150 km/h with >1.5 km)
      const rawCoords = s.coordinates || [];
      const cleanCoords = [];
      let droppedSyncCoords = 0;
      let droppedSupersonicCoords = 0;

      for (let i = 0; i < rawCoords.length; i++) {
        const c = rawCoords[i];
        if (c.eventId && c.eventId.includes(':sync:')) {
          droppedSyncCoords++;
          continue;
        }

        if (cleanCoords.length > 0) {
          const prev = cleanCoords[cleanCoords.length - 1];
          const distKm = haversineDistanceKm(prev.lat, prev.lng, c.lat, c.lng);
          const dtSec = Math.max((new Date(c.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000, 1);
          const speedKmh = distKm / (dtSec / 3600);

          if (speedKmh > 150.0 && distKm > 1.5) {
            droppedSupersonicCoords++;
            continue;
          }
        }

        cleanCoords.push(c);
      }

      console.log(`  Coordinates: ${rawCoords.length} -> ${cleanCoords.length} (dropped ${droppedSyncCoords} sync, ${droppedSupersonicCoords} supersonic jumps)`);

      const lastCleanCoord = cleanCoords.length > 0 ? cleanCoords[cleanCoords.length - 1] : { lat: s.currentLat || 0, lng: s.currentLng || 0 };

      // 4d. Update MongoDB livelocations
      await db.collection('livelocations').updateOne(
        { _id: s._id },
        {
          $set: {
            totalDistance: cleanKm,
            officialDistance: cleanKm,
            acceptedDistance: cleanKm,
            rawGpsDistance: cleanKm,
            coordinates: cleanCoords,
            currentLat: lastCleanCoord.lat,
            currentLng: lastCleanCoord.lng,
            lastActivity: new Date()
          }
        }
      );
      console.log(`  Updated livelocations document (_id: ${s._id}) to cleanKm: ${cleanKm} km`);

      // 4e. Update Upstash Redis
      if (redis) {
        const sessionKey = `session:${s.sessionId}`;
        const redisPayload = {
          totalDistance: cleanKm,
          officialDistance: cleanKm,
          manualDistanceAdded: s.manualDistanceAdded || 0,
          date: targetDate,
          lastLat: lastCleanCoord.lat || 0,
          lastLng: lastCleanCoord.lng || 0,
          lastTs: lastCleanCoord.timestamp ? new Date(lastCleanCoord.timestamp).toISOString() : new Date().toISOString(),
          lastEventId: lastCleanCoord.eventId || null,
          kfState: null,
          lastVx: 0,
          lastVy: 0,
          lastSpeed: 0,
          motionState: s.motionState || 'STATIONARY'
        };

        await redis.set(sessionKey, JSON.stringify(redisPayload), 'EX', 86400);
        console.log(`  Updated Redis ${sessionKey} to ${cleanKm} km (lastLat: ${redisPayload.lastLat}, lastLng: ${redisPayload.lastLng})`);

        // Clear dashboard / monitoring caches
        const orgId = user.organizationId?._id || user.organizationId;
        const keysToClear = [
          `live_locations_${orgId}`,
          `admin_dashboard_${orgId}`,
          `live_locations_${user._id}`,
          `emp_dashboard_stats_${user._id}`,
          'live_locations_all',
          `tracking_session_${s.sessionId}`
        ];
        for (const k of keysToClear) {
          await redis.del(k).catch(() => {});
        }
      }

      results.push({
        employeeName: user.name,
        employeeId: user.employeeId,
        sessionId: s.sessionId,
        cleanKm,
        coordsCount: cleanCoords.length,
        lastCoord: { lat: lastCleanCoord.lat, lng: lastCleanCoord.lng }
      });
    }

    // 4f. Update Attendance for today
    const attendanceRes = await db.collection('attendances').updateMany(
      { employee: user._id, date: targetDate },
      { $set: { totalDistanceTraveled: employeeCumulativeCleanKm } }
    );
    console.log(`  Updated ${attendanceRes.modifiedCount} attendance document(s) to ${employeeCumulativeCleanKm} km`);

    // 4g. Update Users collection
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { totalDistance: employeeCumulativeCleanKm, totalDistanceToday: employeeCumulativeCleanKm } }
    );
    console.log(`  Updated users collection for ${user.name} to ${employeeCumulativeCleanKm} km`);
  }

  // 5. Broadcast Socket.IO events to room 'admins' and org rooms
  console.log(`\n===============================================================`);
  console.log(`Broadcasting Socket.IO employee_location updates to 'admins'...`);

  try {
    const adminUser = await db.collection('users').findOne({
      role: { $in: ['admin', 'ADMIN', 'super_admin', 'SUPER_ADMIN'] }
    });

    if (adminUser) {
      const adminToken = jwt.sign(
        { id: adminUser._id, role: adminUser.role },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      // Connect to port 5001 (active backend server)
      const socket = ioClient('http://localhost:5001', {
        auth: { token: adminToken },
        transports: ['websocket', 'polling']
      });

      await new Promise((resolve) => {
        socket.on('connect', () => {
          console.log(`✅ Connected socket client ${socket.id} to broadcast clean distances`);

          for (const res of results) {
            const broadcastPayload = {
              employeeId: res.employeeId,
              sessionId: res.sessionId,
              totalDistance: res.cleanKm,
              officialDistance: res.cleanKm,
              lat: res.lastCoord.lat,
              lng: res.lastCoord.lng,
              speed: 0,
              name: res.employeeName
            };

            // Emit to server
            socket.emit('admin_broadcast_location', broadcastPayload);
            console.log(`  📡 Emitted admin_broadcast_location for ${res.employeeName} (${res.cleanKm} km)`);
          }

          setTimeout(() => {
            socket.disconnect();
            resolve();
          }, 1000);
        });

        socket.on('connect_error', (err) => {
          console.warn('⚠️ Socket connection warning:', err.message);
          resolve();
        });
      });
    }
  } catch (sockErr) {
    console.warn('Socket broadcast warning:', sockErr.message);
  }

  // 6. Cleanup connections
  if (redis) redis.disconnect();
  await mongoose.disconnect();

  console.log(`\n===============================================================`);
  console.log(`🎉 State Rectification Completed Successfully!`);
  console.log(`Summary of Clean Kilometers:`);
  results.forEach(r => {
    console.log(`  • ${r.employeeName} (${r.employeeId}) | Session: ${r.sessionId} | Clean KM: ${r.cleanKm} km | Coords: ${r.coordsCount}`);
  });
}

rectify().catch((err) => {
  console.error('❌ Rectification failed:', err);
  process.exit(1);
});
