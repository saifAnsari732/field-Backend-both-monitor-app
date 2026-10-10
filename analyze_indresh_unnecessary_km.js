/**
 * analyze_indresh_unnecessary_km.js
 * 
 * Deep Analysis of Indresh Kumar's 3,594 GPS Points for 09 Oct 2026
 * Checks for stationary drift, cell tower jumps, and poor accuracy inflation.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { LiveLocation, TrackingPoint, DistanceLedger } = require('./models/index');

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function analyzePoints() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB.');

    const sessionId = '8fd943f3-6499-41cb-a612-ba52734b05f4'; // Indresh 09 Oct session
    const rawPoints = await TrackingPoint.find({ sessionId }).sort({ timestamp: 1 }).lean();
    const ledgers = await DistanceLedger.find({ sessionId }).lean();

    console.log(`\n================================================================`);
    console.log(`🔍 DEEP AUDIT: Indresh Kumar 09 Oct Session Telemetry`);
    console.log(`================================================================`);
    console.log(`Total Raw Points: ${rawPoints.length}`);
    console.log(`Total DistanceLedger Segments: ${ledgers.length}`);

    // Statistics
    let highAccuracyPoints = 0;   // <= 30m
    let mediumAccuracyPoints = 0; // 31-100m
    let poorAccuracyPoints = 0;   // > 100m

    let zeroSpeedPoints = 0;
    let slowSpeedPoints = 0; // < 2 km/h
    let travelSpeedPoints = 0; // >= 2 km/h

    let totalRawPolylineM = 0;
    let driftDistanceM = 0;
    let validTravelDistanceM = 0;

    for (let i = 0; i < rawPoints.length; i++) {
      const p = rawPoints[i];
      const acc = Number(p.accuracy) || 0;
      const speedKmh = (Number(p.speed) || 0) * 3.6;

      if (acc <= 30) highAccuracyPoints++;
      else if (acc <= 100) mediumAccuracyPoints++;
      else poorAccuracyPoints++;

      if (speedKmh === 0) zeroSpeedPoints++;
      else if (speedKmh < 2.0) slowSpeedPoints++;
      else travelSpeedPoints++;

      if (i > 0) {
        const prev = rawPoints[i - 1];
        const distM = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
        const dtSec = Math.max((new Date(p.timestamp) - new Date(prev.timestamp)) / 1000, 0.1);
        const calcSpeedKmh = (distM / 1000 / dtSec) * 3600;

        totalRawPolylineM += distM;

        // Check if segment is stationary drift (dist < 15m or speed < 1.5 km/h or poor accuracy)
        if (calcSpeedKmh < 1.8 || distM < 12 || acc > 80) {
          driftDistanceM += distM;
        } else {
          validTravelDistanceM += distM;
        }
      }
    }

    console.log(`\n📊 GPS ACCURACY BREAKDOWN:`);
    console.log(`   High Accuracy (<= 30m)  : ${highAccuracyPoints} (${((highAccuracyPoints / rawPoints.length) * 100).toFixed(1)}%)`);
    console.log(`   Medium Accuracy (31-100m): ${mediumAccuracyPoints} (${((mediumAccuracyPoints / rawPoints.length) * 100).toFixed(1)}%)`);
    console.log(`   Poor Accuracy (> 100m)   : ${poorAccuracyPoints} (${((poorAccuracyPoints / rawPoints.length) * 100).toFixed(1)}%)`);

    console.log(`\n📊 REPORTED SPEED BREAKDOWN:`);
    console.log(`   Zero Speed (0 km/h)      : ${zeroSpeedPoints} (${((zeroSpeedPoints / rawPoints.length) * 100).toFixed(1)}%)`);
    console.log(`   Slow Speed (< 2 km/h)    : ${slowSpeedPoints} (${((slowSpeedPoints / rawPoints.length) * 100).toFixed(1)}%)`);
    console.log(`   Real Travel (>= 2 km/h)  : ${travelSpeedPoints} (${((travelSpeedPoints / rawPoints.length) * 100).toFixed(1)}%)`);

    console.log(`\n📊 DISTANCE DISSECTION:`);
    console.log(`   Total Raw Unfiltered Distance   : ${(totalRawPolylineM / 1000).toFixed(2)} KM`);
    console.log(`   Stationary Drift / Jitter Distance: ${(driftDistanceM / 1000).toFixed(2)} KM`);
    console.log(`   Strict Real Travel Distance     : ${(validTravelDistanceM / 1000).toFixed(2)} KM`);
    console.log(`   Current Ledger Stored Distance  : ${(ledgers.reduce((a, b) => a + (b.distanceKm || 0), 0)).toFixed(2)} KM`);

    console.log(`================================================================\n`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error analyzing points:', err);
    process.exit(1);
  }
}

analyzePoints();
