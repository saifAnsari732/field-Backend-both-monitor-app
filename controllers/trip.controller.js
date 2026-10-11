const { TripRouteClaim, LiveLocation, Attendance, ActivityLog } = require('../models');
const routingService = require('../services/routing.service');
const { saveSessionState, getSessionState } = require('../services/cache.service');
const { v4: uuidv4 } = require('uuid');

// 1. Search places (Autocomplete via Google Places with OSM fallback)
exports.searchPlaces = async (req, res) => {
  try {
    const { q, lat, lng } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json({ success: true, predictions: [] });
    }
    const predictions = await routingService.searchPlaces(
      q,
      lat ? parseFloat(lat) : null,
      lng ? parseFloat(lng) : null
    );
    res.json({ success: true, predictions });
  } catch (err) {
    console.error('❌ [TripController] searchPlaces error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 2. Place details (resolve placeId to lat/lng & clean address)
exports.getPlaceDetails = async (req, res) => {
  try {
    const { placeId } = req.query;
    if (!placeId) {
      return res.status(400).json({ success: false, message: 'placeId is required' });
    }
    const details = await routingService.getPlaceDetails(placeId);
    if (!details) {
      return res.status(404).json({ success: false, message: 'Location details could not be found' });
    }
    res.json({ success: true, details });
  } catch (err) {
    console.error('❌ [TripController] getPlaceDetails error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 3. Calculate driving route between origin and destination
exports.calculateRoute = async (req, res) => {
  try {
    const { origin, destination } = req.body;
    if (!origin || !destination) {
      return res.status(400).json({ success: false, message: 'Origin and destination are required' });
    }
    if (!origin.lat || !origin.lng || !destination.lat || !destination.lng) {
      return res.status(400).json({ success: false, message: 'Valid coordinates required for origin and destination' });
    }

    const route = await routingService.calculateDrivingRoute(
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng
    );

    const ratePerKm = Number(req.user.TA || req.user.travelRate || 2.50);
    const reimbursementAmount = Math.round(route.distanceKm * ratePerKm * 100) / 100;

    res.json({
      success: true,
      route: {
        ...route,
        origin,
        destination,
        ratePerKm,
        reimbursementAmount,
      },
    });
  } catch (err) {
    console.error('❌ [TripController] calculateRoute error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 4. Confirm trip & atomically credit KM to LiveLocation & Attendance
exports.confirmTrip = async (req, res) => {
  try {
    const {
      origin,
      destination,
      distanceKm,
      durationMins,
      polyline,
      purpose,
      clientName,
      meetingId,
    } = req.body;

    const km = Number(distanceKm);
    if (!km || km <= 0) {
      return res.status(400).json({ success: false, message: 'Valid distanceKm greater than 0 is required' });
    }
    if (!origin?.address || !destination?.address) {
      return res.status(400).json({ success: false, message: 'Origin and destination addresses are required' });
    }

    const employeeId = req.user._id;
    const orgId = req.user.organizationId?._id || req.user.organizationId;
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    // ── MUTUAL EXCLUSION GUARD: ONLY ONE FEATURE CAN WORK AT A TIME ──
    // If employee is currently Punched In (active live tracking session),
    // they CANNOT claim a planned route simultaneously!
    const activePunchInSession = await LiveLocation.findOne({
      employee: employeeId,
      isActive: true,
    });

    if (activePunchInSession || req.user.isTracking) {
      return res.status(400).json({
        success: false,
        code: 'ACTIVE_PUNCHIN_BLOCK',
        message: 'Mutual Exclusion: You are currently Punched In! Live GPS tracking is active. At one time, only one feature can work: either live GPS tracking OR Planned Route distance claim. Please Punch Out first if you wish to claim this planned trip.',
      });
    }

    const ratePerKm = Number(req.user.TA || req.user.travelRate || 2.50);
    const reimbursementAmount = Math.round(km * ratePerKm * 100) / 100;

    // 1. Create TripRouteClaim record
    const trip = await TripRouteClaim.create({
      organizationId: orgId,
      employee: employeeId,
      date: todayStr,
      origin: {
        address: origin.address,
        lat: Number(origin.lat) || 0,
        lng: Number(origin.lng) || 0,
      },
      destination: {
        address: destination.address,
        lat: Number(destination.lat) || 0,
        lng: Number(destination.lng) || 0,
      },
      distanceKm: km,
      durationMins: Number(durationMins) || 0,
      ratePerKm,
      reimbursementAmount,
      purpose: purpose || 'Client Meeting Travel',
      clientName: clientName || '',
      meetingId: meetingId || null,
      polyline: Array.isArray(polyline) ? polyline : [],
      status: 'credited',
      creditedAt: new Date(),
    });

    // 2. Create standalone completed LiveLocation credit session for today
    const tripSessionId = `TRIP-${uuidv4()}`;
    const sampleCoords = Array.isArray(polyline) && polyline.length > 0
      ? polyline.filter((_, idx) => idx % 5 === 0 || idx === polyline.length - 1).map(pt => ({
          lat: pt.latitude,
          lng: pt.longitude,
          speed: 30,
          accuracy: 10,
          address: destination.address,
          timestamp: new Date(),
        }))
      : [
          { lat: Number(origin.lat) || 0, lng: Number(origin.lng) || 0, address: origin.address, timestamp: new Date() },
          { lat: Number(destination.lat) || 0, lng: Number(destination.lng) || 0, address: destination.address, timestamp: new Date() },
        ];

    const session = await LiveLocation.create({
      organizationId: orgId,
      employee: employeeId,
      sessionId: tripSessionId,
      date: todayStr,
      totalDistance: km,
      officialDistance: km,
      manualDistanceAdded: km,
      manualAdjustmentReason: `Trip Route Claim: ${origin.address} -> ${destination.address}`,
      startAddress: origin.address,
      endAddress: destination.address,
      isActive: false, // credited standalone session
      startTime: new Date(),
      endTime: new Date(),
      coordinates: sampleCoords,
    });

    // 3. Update Attendance for today
    const allTodaySessions = await LiveLocation.find({ employee: employeeId, date: todayStr });
    const dayTotalDistance = Math.round(allTodaySessions.reduce((acc, s) => acc + (s.totalDistance || 0), 0) * 100) / 100;

    let attRecord = await Attendance.findOne({ employee: employeeId, date: todayStr });
    if (attRecord) {
      attRecord.totalDistanceTraveled = dayTotalDistance;
      await attRecord.save();
    } else {
      await Attendance.create({
        organizationId: orgId,
        employee: employeeId,
        date: todayStr,
        checkIn: new Date(),
        totalWorkHours: 0,
        totalDistanceTraveled: dayTotalDistance,
        status: 'present',
      });
    }

    // 4. Log Activity
    await ActivityLog.create({
      employee: employeeId,
      action: 'TRIP_CLAIMED',
      description: `Trip route confirmed: ${km} km (${origin.address} to ${destination.address}). Reimbursed: ₹${reimbursementAmount}`,
      metadata: { tripId: trip._id, distanceKm: km, reimbursementAmount, todayTotalKm: dayTotalDistance },
    });

    // 5. Emit Socket.IO Event
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('trip_claimed', {
        employeeId,
        employeeName: req.user.name,
        distanceKm: km,
        reimbursementAmount,
        origin: origin.address,
        destination: destination.address,
        todayTotalKm: dayTotalDistance,
        timestamp: new Date(),
      });
      io.to('admins').emit('employee_location', {
        employeeId,
        totalDistance: dayTotalDistance,
        latitude: Number(destination.lat) || 0,
        longitude: Number(destination.lng) || 0,
        address: destination.address,
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      message: `Successfully credited ${km} km (₹${reimbursementAmount}) to your account.`,
      creditedKm: km,
      reimbursementAmount,
      todayTotalKm: dayTotalDistance,
      trip,
    });
  } catch (err) {
    console.error('❌ [TripController] confirmTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 5. Get user's claimed trips
exports.getMyTrips = async (req, res) => {
  try {
    const employeeId = req.user._id;
    const { date, limit = 20, page = 1 } = req.query;

    const filter = { employee: employeeId };
    if (date) {
      filter.date = date;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const trips = await TripRouteClaim.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalCount = await TripRouteClaim.countDocuments(filter);
    const totalKm = trips.reduce((sum, t) => sum + (t.distanceKm || 0), 0);
    const totalPayout = trips.reduce((sum, t) => sum + (t.reimbursementAmount || 0), 0);

    res.json({
      success: true,
      trips,
      totalCount,
      summary: {
        totalKm: Math.round(totalKm * 100) / 100,
        totalPayout: Math.round(totalPayout * 100) / 100,
      },
    });
  } catch (err) {
    console.error('❌ [TripController] getMyTrips error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 6. Get all team trips (for Org Admin & Manager)
exports.getTeamTrips = async (req, res) => {
  try {
    const orgId = req.user.organizationId?._id || req.user.organizationId;
    const { date, employeeId, status, limit = 50, page = 1 } = req.query;

    const filter = { organizationId: orgId };
    if (date) filter.date = date;
    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const trips = await TripRouteClaim.find(filter)
      .populate('employee', 'name email role phone avatar department employeeId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalCount = await TripRouteClaim.countDocuments(filter);

    // Calculate overall aggregates for this filter
    const allMatching = await TripRouteClaim.find(filter).select('distanceKm reimbursementAmount employee').lean();
    const totalKm = allMatching.reduce((acc, t) => acc + (t.distanceKm || 0), 0);
    const totalPayout = allMatching.reduce((acc, t) => acc + (t.reimbursementAmount || 0), 0);
    const uniqueEmployees = new Set(allMatching.map(t => String(t.employee))).size;

    res.json({
      success: true,
      trips,
      totalCount,
      summary: {
        totalTrips: totalCount,
        totalKm: Math.round(totalKm * 100) / 100,
        totalPayout: Math.round(totalPayout * 100) / 100,
        uniqueEmployees,
      },
    });
  } catch (err) {
    console.error('❌ [TripController] getTeamTrips error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 7. Update Trip Status (Org Admin approval / rejection / audit)
exports.updateTripStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remarks } = req.body;
    const orgId = req.user.organizationId?._id || req.user.organizationId;

    if (!['credited', 'pending', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const trip = await TripRouteClaim.findOne({ _id: id, organizationId: orgId });
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip claim not found' });
    }

    trip.status = status;
    if (remarks) trip.remarks = remarks;
    await trip.save();

    res.json({ success: true, message: `Trip status updated to ${status}`, trip });
  } catch (err) {
    console.error('❌ [TripController] updateTripStatus error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// 8. Delete Trip Claim (Org Admin only)
exports.deleteTripClaim = async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.organizationId?._id || req.user.organizationId;

    const trip = await TripRouteClaim.findOneAndDelete({ _id: id, organizationId: orgId });
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip claim not found' });
    }

    res.json({ success: true, message: 'Trip claim deleted successfully' });
  } catch (err) {
    console.error('❌ [TripController] deleteTripClaim error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

