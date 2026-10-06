const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://kisandeveloper2_db_user:dtyYYIPcSWschnEm@ac-r9udvqk-shard-00-00.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-01.qoelzmc.mongodb.net:27017,ac-r9udvqk-shard-00-02.qoelzmc.mongodb.net:27017/?ssl=true&replicaSet=atlas-yz1at6-shard-0&authSource=admin&appName=kisanField-App';

function haversineDistance(p1, p2) {
  const R = 6371;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function auditLalit() {
  try {
    await mongoose.connect(uri);

    const User = mongoose.model('User', new mongoose.Schema({ name: String, employeeId: String }));
    const LiveLocation = mongoose.model('LiveLocation', new mongoose.Schema({
      sessionId: String, employee: mongoose.Schema.Types.ObjectId, totalDistance: Number, date: String, startTime: Date, coordinates: Array
    }));
    const TrackingPoint = mongoose.model('TrackingPoint', new mongoose.Schema({
      sessionId: String, employee: mongoose.Schema.Types.ObjectId, timestamp: Date, lat: Number, lng: Number, speed: Number, accuracy: Number
    }));

    const lalitUsers = await User.find({ name: /Lalit/i }).lean();

    for (const user of lalitUsers) {
      console.log(`\n==================================================`);
      console.log(`Auditing User: ${user.name} (_id: ${user._id})`);

      const today = '2026-10-06';
      const sessions = await LiveLocation.find({ employee: user._id, $or: [{ date: today }, { isActive: true }] }).lean();

      for (const s of sessions) {
        console.log(`\nSessionId: ${s.sessionId} | Date: ${s.date} | Stored Total: ${s.totalDistance} km | Coords Count: ${s.coordinates?.length || 0}`);
        
        const rawPoints = await TrackingPoint.find({ sessionId: s.sessionId }).sort({ timestamp: 1 }).lean();
        console.log(`Raw Points in DB: ${rawPoints.length}`);

        let totalValidKm = 0;
        let prev = null;

        rawPoints.forEach((pt, idx) => {
          if (prev) {
            const dRaw = haversineDistance({ lat: prev.lat, lng: prev.lng }, { lat: pt.lat, lng: pt.lng });
            const dtSec = Math.max((new Date(pt.timestamp) - new Date(prev.timestamp)) / 1000, 0.5);
            const speedKmh = (dRaw / dtSec) * 3600;

            if (dtSec > 3600) {
              console.log(`  ⚓ [GAP RE-ANCHOR Step ${idx}] dt=${(dtSec/3600).toFixed(1)} hours > 1h gap (${dRaw.toFixed(1)} km). Distance NOT added.`);
              prev = pt;
              return;
            }

            const isAcceptable = dRaw * 1000 >= 1.0 && speedKmh <= 90 && (dRaw <= 15 || dtSec >= 600);
            if (isAcceptable) {
              totalValidKm += dRaw * 1.05;
            } else {
              console.log(`  ❌ [REJECTED Step ${idx}] ${dRaw.toFixed(3)} km | dt=${dtSec.toFixed(1)}s | speed=${speedKmh.toFixed(1)} km/h`);
            }
          }
          prev = pt;
        });

        console.log(`\n>>> ACCURATE KM WITH GAP RE-ANCHORING: ${totalValidKm.toFixed(2)} KM`);
      }
    }

    mongoose.disconnect();
  } catch (err) {
    console.error('Audit Error:', err);
  }
}

auditLalit();
