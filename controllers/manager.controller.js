const { Meeting, Expense, Attendance, LiveLocation, Leave, Task, DistanceLedger } = require('../models/index');
const User = require('../models/User.model');
const { getSessionState } = require('../services/cache.service');

function getBusinessDate(date = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// Helper to build the unified team filter for a manager (supports manager, managerId, and assignedEmployees array)
function getTeamFilter(user) {
  const orConditions = [
    { manager: user._id },
    { managerId: user._id }
  ];
  if (Array.isArray(user.assignedEmployees) && user.assignedEmployees.length > 0) {
    const assignedIds = user.assignedEmployees
      .map(e => (e && e._id ? e._id : e))
      .filter(Boolean);
    if (assignedIds.length > 0) {
      orConditions.push({ _id: { $in: assignedIds } });
    }
  }
  return { $or: orConditions };
}

// ─── Manager Dashboard Stats ──────────────────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const myTeamFilter = getTeamFilter(req.user);
    const teamMembers = await User.find(myTeamFilter).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const todayStart = new Date(`${today}T00:00:00.000+05:30`);

    const [
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      todayAttendance, totalLeaves, totalTasks,
      totalKmData, ledgerKmData
    ] = await Promise.all([
      User.countDocuments(myTeamFilter),
      User.countDocuments({ ...myTeamFilter, isOnline: true }),
      User.countDocuments({ ...myTeamFilter, isTracking: true }),
      Meeting.countDocuments({ employee: { $in: teamIds } }),
      Meeting.countDocuments({ employee: { $in: teamIds }, date: { $gte: todayStart } }),
      Expense.countDocuments({ employee: { $in: teamIds }, status: 'pending' }),
      Attendance.countDocuments({ employee: { $in: teamIds }, date: today, status: { $in: ['present', 'late', 'half-day'] } }),
      Leave.countDocuments({ employee: { $in: teamIds } }),
      Task.countDocuments({ employee: { $in: teamIds } }),
      LiveLocation.aggregate([
        { $match: { employee: { $in: teamIds }, $or: [{ date: today }, { isActive: true }] } },
        { $group: { _id: null, total: { $sum: '$totalDistance' } } }
      ]),
      DistanceLedger.aggregate([
        {
          $match: {
            employee: { $in: teamIds },
            classification: { $in: ['ACCEPTED', 'RECOVERED'] },
            reason: { $ne: 'AGTRIE_X_SCREEN_TELEMETRY_SYNC' },
            toTimestamp: { $gte: todayStart }
          }
        },
        { $group: { _id: null, total: { $sum: '$distanceKm' } } }
      ])
    ]);

    const totalKmToday = Math.round(Math.max(totalKmData[0]?.total || 0, ledgerKmData[0]?.total || 0) * 100) / 100;

    res.json({
      success: true,
      stats: {
        totalEmployees, activeEmployees, trackingNow,
        totalMeetings, todayMeetings, pendingExpenses,
        todayAttendance, totalLeaves, totalTasks,
        totalKmToday,
        totalKm: totalKmToday,
        teamSize: teamIds.length
      }
    });
  } catch (err) {
    console.error('Manager dashboard error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Get My Team ──────────────────────────────────────────────────────────────
exports.getMyTeam = async (req, res) => {
  try {
    const { page = 1, limit = 100, search } = req.query;
    const teamFilter = getTeamFilter(req.user);
    const filter = { ...teamFilter };
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      filter.$and = [
        teamFilter,
        { $or: [{ name: searchRegex }, { email: searchRegex }, { employeeId: searchRegex }] }
      ];
      delete filter.$or;
    }
    const [employees, total] = await Promise.all([
      User.find(filter).select('-password').sort({ isTracking: -1, isOnline: -1, createdAt: -1 }).skip((page - 1) * limit).limit(+limit).lean(),
      User.countDocuments(filter)
    ]);

    const empIds = employees.map(e => e._id);
    const today = getBusinessDate(new Date(), 'Asia/Kolkata');
    const startOfToday = new Date(`${today}T00:00:00.000+05:30`);

    const [todayAttendances, todayLiveLocations, todayLedgerAggs] = await Promise.all([
      Attendance.find({ employee: { $in: empIds }, $or: [{ date: today }, { createdAt: { $gte: startOfToday } }] }).lean(),
      LiveLocation.find(
        { employee: { $in: empIds }, $or: [{ date: today }, { createdAt: { $gte: startOfToday } }, { isActive: true }] },
        { coordinates: { $slice: -1 }, rejectionReasons: 0 }
      ).lean(),
      DistanceLedger.aggregate([
        {
          $match: {
            employee: { $in: empIds },
            classification: { $in: ['ACCEPTED', 'RECOVERED'] },
            reason: { $ne: 'AGTRIE_X_SCREEN_TELEMETRY_SYNC' },
            toTimestamp: { $gte: startOfToday }
          }
        },
        { $group: { _id: '$employee', totalKm: { $sum: '$distanceKm' } } }
      ])
    ]);

    const attMap = new Map();
    todayAttendances.forEach(a => {
      const empKey = String(a.employee);
      const existing = attMap.get(empKey);
      if (!existing || (a.totalDistanceTraveled || 0) > (existing.totalDistanceTraveled || 0)) {
        attMap.set(empKey, a);
      }
    });

    const ledgerMap = new Map(todayLedgerAggs.map(a => [String(a._id), Number(a.totalKm || 0)]));
    const empSessionsDistMap = new Map();
    const liveMap = new Map();

    for (const l of todayLiveLocations) {
      const empKey = String(l.employee);
      let sessionDist = Number(l.totalDistance) || Number(l.officialDistance) || Number(l.acceptedDistance) || 0;
      if (l.isActive && l.sessionId) {
        try {
          const sState = await getSessionState(l.sessionId);
          if (sState && Number(sState.totalDistance) > sessionDist) {
            sessionDist = Number(sState.totalDistance);
          }
        } catch (_) {}
      }
      empSessionsDistMap.set(empKey, (empSessionsDistMap.get(empKey) || 0) + sessionDist);
      const existing = liveMap.get(empKey);
      if (!existing || (l.isActive && !existing.isActive) || (l.isActive === Boolean(existing.isActive) && new Date(l.updatedAt || 0) > new Date(existing.updatedAt || 0))) {
        liveMap.set(empKey, { ...l, totalDistance: sessionDist });
      }
    }

    const enrichedEmployees = employees.map(empObj => {
      const empIdStr = String(empObj._id);
      const att = attMap.get(empIdStr);
      const live = liveMap.get(empIdStr);
      const latestCoord = (live?.coordinates && live.coordinates[live.coordinates.length - 1]) || {};
      const isLive = live?.isActive === true || empObj.isTracking === true || (Boolean(att?.checkIn) && !att?.checkOut);
      const todayKm = Math.round(Math.max(
        Number(att?.totalDistanceTraveled) || 0,
        empSessionsDistMap.get(empIdStr) || 0,
        ledgerMap.get(empIdStr) || 0,
        Number(live?.totalDistance) || 0,
        Number(live?.officialDistance) || 0
      ) * 100) / 100;

      return {
        ...empObj,
        isTracking: isLive,
        isLive,
        todayKm,
        totalDistance: todayKm,
        totalDistanceToday: todayKm,
        lat: latestCoord.lat,
        lng: latestCoord.lng,
        speed: (live?.motionState === 'STATIONARY') ? 0 : (latestCoord.speed || 0),
        motionState: live?.motionState || 'STATIONARY',
        lastPing: live?.lastActivity || live?.updatedAt || att?.checkIn || empObj.lastSeen || empObj.updatedAt,
        currentAddress: latestCoord.address || live?.currentAddress || live?.endAddress || live?.startAddress || empObj.address
      };
    });

    res.json({ success: true, employees: enrichedEmployees, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Get Team Meetings ────────────────────────────────────────────────────────
exports.getTeamMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId } = req.query;
    const teamMembers = await User.find(getTeamFilter(req.user)).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const filter = { employee: { $in: teamIds } };
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    const meetings = await Meeting.find(filter).populate('employee', 'name employeeId department designation').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Get Team Expenses ────────────────────────────────────────────────────────
exports.getTeamExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId } = req.query;
    const teamMembers = await User.find(getTeamFilter(req.user)).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const filter = { employee: { $in: teamIds } };
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    const expenses = await Expense.find(filter).populate('employee', 'name employeeId department designation').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Expense.countDocuments(filter);
    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Get Team Attendance ──────────────────────────────────────────────────────
exports.getTeamAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    const teamMembers = await User.find(getTeamFilter(req.user)).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const filter = { employee: { $in: teamIds } };
    if (date) filter.date = date;
    const records = await Attendance.find(filter).populate('employee', 'name employeeId department designation').sort({ date: -1 });
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Get Team Tracking/Travel Report ─────────────────────────────────────────
exports.getTeamTrackingHistory = async (req, res) => {
  try {
    const { date, employeeId, page = 1, limit = 50 } = req.query;
    const teamMembers = await User.find(getTeamFilter(req.user)).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const filter = { employee: { $in: teamIds } };
    if (date) {
      filter.$or = [{ date }, { isActive: true }];
    }
    if (employeeId) filter.employee = employeeId;

    const history = await LiveLocation.find(filter)
      .populate('employee', 'name employeeId department designation avatar')
      .sort({ isActive: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const { DistanceLedger } = require('../models/index');
    const sanitizedHistory = await Promise.all((history || []).map(async (doc) => {
      const s = doc.toObject ? doc.toObject() : { ...doc };
      const ledgerAgg = await DistanceLedger.aggregate([
        { $match: { sessionId: s.sessionId, classification: 'ACCEPTED' } },
        { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
      ]);
      if (ledgerAgg && ledgerAgg.length > 0 && typeof ledgerAgg[0].totalKm === 'number' && ledgerAgg[0].totalKm > 0) {
        const verifiedKm = Math.round(ledgerAgg[0].totalKm * 100) / 100;
        s.totalDistance = verifiedKm;
        s.officialDistance = verifiedKm;
      }
      return s;
    }));

    const total = await LiveLocation.countDocuments(filter);

    res.json({ success: true, history: sanitizedHistory, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
