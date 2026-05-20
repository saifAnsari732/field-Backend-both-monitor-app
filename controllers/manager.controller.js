const { Meeting, Expense, Attendance, LiveLocation, Leave, Task } = require('../models/index');
const User = require('../models/User.model');


// ─── Manager Dashboard Stats ──────────────────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const myTeamFilter = { manager: req.user._id };
    const teamMembers = await User.find(myTeamFilter).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const today = new Date().toISOString().slice(0, 10);

    const [
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      todayAttendance, totalLeaves, totalTasks,
      totalKmData
    ] = await Promise.all([
      User.countDocuments(myTeamFilter),
      User.countDocuments({ ...myTeamFilter, isOnline: true }),
      User.countDocuments({ ...myTeamFilter, isTracking: true }),
      Meeting.countDocuments({ employee: { $in: teamIds } }),
      Meeting.countDocuments({ employee: { $in: teamIds }, date: { $gte: new Date(today) } }),
      Expense.countDocuments({ employee: { $in: teamIds }, status: 'pending' }),
      Attendance.countDocuments({ employee: { $in: teamIds }, date: today, status: 'present' }),
      Leave.countDocuments({ employee: { $in: teamIds } }),
      Task.countDocuments({ employee: { $in: teamIds } }),
      LiveLocation.aggregate([
        { $match: { employee: { $in: teamIds }, date: today } },
        { $group: { _id: null, total: { $sum: '$totalDistance' } } }
      ])
    ]);

    res.json({
      success: true,
      stats: {
        totalEmployees, activeEmployees, trackingNow,
        totalMeetings, todayMeetings, pendingExpenses,
        todayAttendance, totalLeaves, totalTasks,
        totalKmToday: totalKmData[0]?.total || 0,
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
    const { page = 1, limit = 20, search } = req.query;
    const filter = { manager: req.user._id };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } }
      ];
    }
    const employees = await User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await User.countDocuments(filter);
    res.json({ success: true, employees, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Get Team Meetings ────────────────────────────────────────────────────────
exports.getTeamMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId } = req.query;
    const teamMembers = await User.find({ manager: req.user._id }).select('_id');
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
    const teamMembers = await User.find({ manager: req.user._id }).select('_id');
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
    const teamMembers = await User.find({ manager: req.user._id }).select('_id');
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
    const teamMembers = await User.find({ manager: req.user._id }).select('_id');
    const teamIds = teamMembers.map(emp => emp._id);
    const filter = { employee: { $in: teamIds } };
    if (date) filter.date = date;
    if (employeeId) filter.employee = employeeId;

    const history = await LiveLocation.find(filter)
      .populate('employee', 'name employeeId department designation avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const total = await LiveLocation.countDocuments(filter);

    // Per-employee summary for the day
    const summaryPipeline = [
      { $match: filter },
      { $group: { _id: '$employee', totalKm: { $sum: '$totalDistance' }, sessions: { $sum: 1 } } }
    ];
    const summary = await LiveLocation.aggregate(summaryPipeline);

    res.json({ success: true, history, total, pages: Math.ceil(total / limit), summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
