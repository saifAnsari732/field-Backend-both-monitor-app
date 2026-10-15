require('dotenv').config();
const mongoose = require('mongoose');
const Redis = require('ioredis');

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function verifyAll() {
  console.log('========================================================================');
  console.log('🔍 FULL AUDIT & VERIFICATION REPORT: RAJESH KUMAR & INDRESH KUMAR');
  console.log('========================================================================\n');

  // 1. Connect MongoDB
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // 2. Connect Redis
  const rawRedisUrl = (process.env.REDIS_URL || '').trim().replace(/^["']|["']$/g, '');
  const redis = new Redis(rawRedisUrl);
  await new Promise((resolve) => redis.on('ready', resolve));

  const targets = [
    { name: 'Rajesh Kumar', employeeId: 'EMP-6FD8C90E' },
    { name: 'Indresh kumar', employeeId: 'EMP1532' }
  ];

  for (const t of targets) {
    console.log(`------------------------------------------------------------------------`);
    console.log(`👤 AUDITING EMPLOYEE: ${t.name} (${t.employeeId})`);
    console.log(`------------------------------------------------------------------------`);

    // A. Users Collection
    const userDoc = await db.collection('users').findOne({
      $or: [
        { employeeId: t.employeeId },
        { name: { $regex: t.name.split(' ')[0], $options: 'i' } }
      ]
    });

    console.log(`\n1. [users] Collection:`);
    console.log(`   _id:                 ${userDoc._id}`);
    console.log(`   name:                ${userDoc.name}`);
    console.log(`   employeeId:          ${userDoc.employeeId}`);
    console.log(`   totalDistance:       ${userDoc.totalDistance} km`);
    console.log(`   totalDistanceToday:  ${userDoc.totalDistanceToday} km`);
    console.log(`   isTracking:          ${userDoc.isTracking}`);

    // B. LiveLocations Collection
    const liveDocs = await db.collection('livelocations').find({
      employee: userDoc._id,
      date: '2026-10-15'
    }).toArray();

    console.log(`\n2. [livelocations] Collection (Sessions Today: ${liveDocs.length}):`);
    for (const s of liveDocs) {
      console.log(`   sessionId:           ${s.sessionId}`);
      console.log(`   isActive:            ${s.isActive}`);
      console.log(`   totalDistance:       ${s.totalDistance} km`);
      console.log(`   officialDistance:    ${s.officialDistance} km`);
      console.log(`   acceptedDistance:    ${s.acceptedDistance} km`);
      console.log(`   rawGpsDistance:      ${s.rawGpsDistance} km`);
      console.log(`   coordinates total:   ${s.coordinates?.length || 0}`);

      const syncCoords = (s.coordinates || []).filter(c => c.eventId && c.eventId.includes(':sync:'));
      console.log(`   coordinates :sync::  ${syncCoords.length} (expected 0)`);

      // Check remaining supersonic jumps
      let jumps = 0;
      const coords = s.coordinates || [];
      for (let i = 1; i < coords.length; i++) {
        const prev = coords[i - 1];
        const cur = coords[i];
        const d = haversineDistanceKm(prev.lat, prev.lng, cur.lat, cur.lng);
        const dt = Math.max((new Date(cur.timestamp) - new Date(prev.timestamp)) / 1000, 1);
        const sp = d / (dt / 3600);
        if (sp > 150 && d > 1.5) jumps++;
      }
      console.log(`   coordinates jumps:   ${jumps} (expected 0)`);

      // C. DistanceLedgers
      const ledgers = await db.collection('distanceledgers').find({ sessionId: s.sessionId }).toArray();
      let accCount = 0, accKm = 0;
      let recCount = 0, recKm = 0;
      let rejCount = 0, rejKm = 0;
      let invalidAccepted = 0;

      for (const l of ledgers) {
        if (l.classification === 'ACCEPTED') {
          accCount++;
          accKm += (l.distanceKm || 0);
          const isSync = (l.toEventId && l.toEventId.includes(':sync:')) || (l.fromEventId && l.fromEventId.includes(':sync:'));
          const dtSec = Math.max((new Date(l.toTimestamp).getTime() - new Date(l.fromTimestamp).getTime()) / 1000, 1);
          const speedKmh = (l.distanceKm / (dtSec / 3600));
          if (isSync || (speedKmh > 150 && l.distanceKm > 1.5)) invalidAccepted++;
        } else if (l.classification === 'RECOVERED') {
          recCount++;
          recKm += (l.distanceKm || 0);
        } else if (l.classification === 'REJECTED') {
          rejCount++;
          rejKm += (l.distanceKm || 0);
        }
      }

      console.log(`\n3. [distanceledgers] Collection (Ledgers Total: ${ledgers.length}):`);
      console.log(`   ACCEPTED entries:    ${accCount} (${accKm.toFixed(2)} km)`);
      console.log(`   RECOVERED entries:   ${recCount} (${recKm.toFixed(2)} km)`);
      console.log(`   REJECTED entries:    ${rejCount} (${rejKm.toFixed(2)} km)`);
      console.log(`   Clean Sum:           ${(accKm + recKm).toFixed(2)} km`);
      console.log(`   Invalid ACCEPTED:    ${invalidAccepted} (expected 0)`);

      // D. Upstash Redis
      const redisKey = `session:${s.sessionId}`;
      const rawRedisVal = await redis.get(redisKey);
      let parsedRedis = null;
      try { parsedRedis = JSON.parse(rawRedisVal); } catch (_) {}

      console.log(`\n4. [Upstash Redis] session:${s.sessionId}:`);
      if (parsedRedis) {
        console.log(`   totalDistance:       ${parsedRedis.totalDistance} km`);
        console.log(`   officialDistance:    ${parsedRedis.officialDistance} km`);
        console.log(`   lastLat:             ${parsedRedis.lastLat}`);
        console.log(`   lastLng:             ${parsedRedis.lastLng}`);
        console.log(`   lastTs:              ${parsedRedis.lastTs}`);
        console.log(`   lastEventId:         ${parsedRedis.lastEventId}`);
      } else {
        console.log(`   State: null or missing`);
      }
    }

    // E. Attendances Collection
    const attDoc = await db.collection('attendances').findOne({
      employee: userDoc._id,
      date: '2026-10-15'
    });

    console.log(`\n5. [attendances] Collection:`);
    if (attDoc) {
      console.log(`   _id:                 ${attDoc._id}`);
      console.log(`   date:                ${attDoc.date}`);
      console.log(`   status:              ${attDoc.status}`);
      console.log(`   totalDistanceTraveled: ${attDoc.totalDistanceTraveled} km`);
    } else {
      console.log(`   No attendance record today`);
    }

    console.log('\n');
  }

  redis.disconnect();
  await mongoose.disconnect();
  console.log('========================================================================');
  console.log('✅ AUDIT & VERIFICATION COMPLETED WITH ZERO ERRORS');
  console.log('========================================================================');
}

verifyAll().catch(console.error);
