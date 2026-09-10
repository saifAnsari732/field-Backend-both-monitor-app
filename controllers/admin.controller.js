// ─── Meeting Controller ───────────────────────────────────────────────────────
const { Meeting, Expense, Attendance, ActivityLog, Notification, LiveLocation, Lead, Leave, Task } = require('../models/index');
const User = require('../models/User.model');
const { liveCache } = require('../services/cache.service');

// Meeting CRUD
exports.createMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.create({ ...req.body, employee: req.user._id });
    await ActivityLog.create({ employee: req.user._id, action: 'MEETING_CREATED', description: `Meeting with ${meeting.clientName}` });
    const io = req.app.get('io');
    io.to('admins').emit('new_meeting', { meeting, employeeName: req.user.name });
    res.status(201).json({ success: true, meeting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getMyMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, date } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;
    if (date) { const d = new Date(date); filter.date = { $gte: d, $lt: new Date(d.getTime() + 86400000) }; }
    const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, employee: req.user._id }, req.body, { new: true }
    );
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });
    res.json({ success: true, meeting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Expense Controller ───────────────────────────────────────────────────────
exports.createExpense = async (req, res) => {
  try {
    const expense = await Expense.create({ ...req.body, employee: req.user._id });
    await ActivityLog.create({ employee: req.user._id, action: 'EXPENSE_SUBMITTED', description: `₹${expense.amount} - ${expense.category}` });
    const io = req.app.get('io');
    io.to('admins').emit('new_expense', { expense, employeeName: req.user.name });
    res.status(201).json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getMyExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, category } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;
    if (category) filter.category = category;
    const expenses = await Expense.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Expense.countDocuments(filter);
    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// ─── Admin Controller ─────────────────────────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const cacheKey = 'admin_dashboard_stats';
    const cachedStats = await liveCache.get(cacheKey);
    if (cachedStats) {
      return res.json({ success: true, stats: cachedStats, fromCache: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const [
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      totalExpenses, todayAttendance, totalKmData,
      totalLeads, totalLeaves, totalTasks
    ] = await Promise.all([
      User.countDocuments({ role: 'employee', isApproved: true }),
      User.countDocuments({ role: 'employee', isOnline: true }),
      User.countDocuments({ role: 'employee', isTracking: true }),
      Meeting.countDocuments(),
      Meeting.countDocuments({ date: { $gte: new Date(today) } }),
      Expense.countDocuments({ status: 'pending' }),
      Expense.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      Attendance.countDocuments({ date: today, status: 'present' }),
      LiveLocation.aggregate([
        { $match: { date: today } },
        { $group: { _id: null, total: { $sum: '$totalDistance' } } }
      ]),
      Lead.countDocuments(),
      Leave.countDocuments({}),
      Task.countDocuments({}),
    ]);

    const monthlyMeetings = await Meeting.aggregate([
      { $group: { _id: { $month: '$date' }, count: { $sum: 1 } } },
      { $sort: { '_id': 1 } }
    ]);

    const expenseByCategory = await Expense.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);

    const stats = {
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      totalExpenses: totalExpenses[0]?.total || 0,
      todayAttendance,
      totalKm: totalKmData[0]?.total || 0,
      totalLeads: totalLeads || 0,
      totalLeaves: totalLeaves || 0,
      totalTasks: totalTasks || 0,
      monthlyMeetings, expenseByCategory,
    };

    await liveCache.set(cacheKey, stats, 60); // Cache for 1 minute

    res.json({
      success: true,
      stats
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllEmployees = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, department, isActive, role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    else filter.role = 'employee';
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { employeeId: { $regex: search, $options: 'i' } }];
    if (department) filter.department = department;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const employees = await User.find(filter).populate('manager', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await User.countDocuments(filter);
    res.json({ success: true, employees, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.approveEmployee = async (req, res) => {
  try {
    const employee = await User.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
    const io = req.app.get('io');
    if (employee.socketId) io.to(employee.socketId).emit('account_approved', { message: 'Your account has been approved!' });
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.toggleBlock = async (req, res) => {
  try {
    const employee = await User.findById(req.params.id);
    employee.isBlocked = !employee.isBlocked;
    await employee.save();
    res.json({ success: true, isBlocked: employee.isBlocked });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.updateEmployee = async (req, res) => {
  try {
    const employee = await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getManagers = async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager' }).select('name email designation employeeId department role allocatedArea address isActive isOnline isTracking isApproved isBlocked salary TA').sort({ name: 1 });
    res.json({ success: true, managers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.approveExpense = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const expense = await Expense.findByIdAndUpdate(req.params.id, {
      status, approvedBy: req.user._id, approvedAt: new Date(),
      ...(rejectionReason && { rejectionReason })
    }, { new: true }).populate('employee', 'name socketId');
    
    const io = req.app.get('io');
    if (expense.employee.socketId) {
      io.to(expense.employee.socketId).emit('expense_status_update', { expenseId: expense._id, status });
    }
    res.json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, employeeId, status } = req.query;
    const filter = {};
    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;
    const meetings = await Meeting.find(filter).populate('employee', 'name employeeId department').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Meeting.countDocuments(filter);
    res.json({ success: true, meetings, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllExpenses = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employeeId, category } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    if (category) filter.category = category;
    const expenses = await Expense.find(filter).populate('employee', 'name employeeId department').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    const total = await Expense.countDocuments(filter);
    res.json({ success: true, expenses, total, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAttendanceReport = async (req, res) => {
  try {
    const { date, employeeId } = req.query;
    const filter = {};
    if (date) filter.date = date;
    if (employeeId) filter.employee = employeeId;
    const records = await Attendance.find(filter).populate('employee', 'name employeeId department').sort({ date: -1 });
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getTrackingHistory = async (req, res) => {
  try {
    const { employeeId, date, startDate, endDate, page = 1, limit = 100 } = req.query;
    const filter = {};
    if (employeeId) filter.employee = employeeId;
    
    if (startDate && endDate) {
      filter.date = { $gte: startDate, $lte: endDate };
    } else if (date) {
      filter.date = date;
    }

    const history = await LiveLocation.find(filter, { 
      coordinates: { $slice: -1 } // Only get the last coordinate for the marker
    })
      .populate('employee', 'name employeeId department avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const total = await LiveLocation.countDocuments(filter);

    res.json({
      success: true,
      history,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Get All Managers (for dropdown) ─────────────────────────────────────────
exports.getManagers = async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager' })
      .select('_id name email employeeId department designation')
      .sort({ name: 1 });
    res.json({ success: true, managers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
