require('dotenv').config();
const mongoose = require('mongoose');
const { User, LiveLocation } = require('./models');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ansarisaifuddin732_db_user:M2oWIFAFysw7DpGi@cluster0.gbipgw2.mongodb.net/';

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function analyzePoints() {
  await mongoose.connect(mongoUri);
  const user = await User.findOne({ name: { $regex: 'saifuddin', $options: 'i' } });
  const activeLoc = await LiveLocation.findOne({ employee: user._id, isActive: true }).sort({ createdAt: -1 });

  const coords = activeLoc.coordinates || [];
  console.log(`Total coords: ${coords.length}`);

  if (coords.length === 0) process.exit(0);

  const start = coords[0];
  let maxDistM = 0;
  let maxDistCoord = null;
  let totalRawHaversineM = 0;

  for (let i = 1; i < coords.length; i++) {
    const c = coords[i];
    const prev = coords[i - 1];
    const stepM = haversineMeters(prev.lat, prev.lng, c.lat, c.lng);
    totalRawHaversineM += stepM;

    const fromStartM = haversineMeters(start.lat, start.lng, c.lat, c.lng);
    if (fromStartM > maxDistM) {
      maxDistM = fromStartM;
      maxDistCoord = c;
    }
  }

  console.log(`Max displacement from start point (${start.lat}, ${start.lng}): ${maxDistM.toFixed(2)} meters`);
  console.log(`Total cumulative raw step-by-step drift: ${totalRawHaversineM.toFixed(2)} meters (${(totalRawHaversineM / 1000).toFixed(3)} km)`);

  process.exit(0);
}

analyzePoints();
