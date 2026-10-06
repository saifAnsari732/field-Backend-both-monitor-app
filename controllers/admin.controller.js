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
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;
    const cacheKey = `admin_dashboard_stats_${isSuperAdmin ? 'super' : orgId || req.user?._id}`;

    const cachedStats = await liveCache.get(cacheKey);
    if (cachedStats) {
      return res.json({ success: true, stats: cachedStats, fromCache: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const userFilter = isSuperAdmin ? {} : { organizationId: orgId };

    if (userRole === 'MANAGER') {
      userFilter.$or = [{ managerId: req.user._id }, { manager: req.user._id }, { _id: req.user._id }];
    }

    // Get list of matching employee IDs for scoped sub-queries
    const scopedEmployees = await User.find(userFilter).select('_id');
    const empIds = scopedEmployees.map(e => e._id);

    const [
      totalEmployees, activeEmployees, trackingNow,
      totalMeetings, todayMeetings, pendingExpenses,
      totalExpenses, presentCount, lateCount, halfDayCount,
      totalKmData, totalLeads, totalLeaves, totalTasks
    ] = await Promise.all([
      User.countDocuments({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, isApproved: true, ...userFilter }),
      User.countDocuments({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, isOnline: true, ...userFilter }),
      User.countDocuments({ role: { $nin: ['SUPER_ADMIN', 'SUPERADMIN'] }, isTracking: true, ...userFilter }),
      Meeting.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Meeting.countDocuments(isSuperAdmin ? { date: { $gte: new Date(today) } } : { employee: { $in: empIds }, date: { $gte: new Date(today) } }),
      Expense.countDocuments(isSuperAdmin ? { status: 'pending' } : { employee: { $in: empIds }, status: 'pending' }),
      Expense.aggregate([
        ...(isSuperAdmin ? [] : [{ $match: { employee: { $in: empIds } } }]),
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: { $in: ['present', 'late', 'half-day'] } } : { employee: { $in: empIds }, date: today, status: { $in: ['present', 'late', 'half-day'] } }),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: 'late' } : { employee: { $in: empIds }, date: today, status: 'late' }),
      Attendance.countDocuments(isSuperAdmin ? { date: today, status: 'half-day' } : { employee: { $in: empIds }, date: today, status: 'half-day' }),
      LiveLocation.aggregate([
        { $match: { date: today, ...(isSuperAdmin ? {} : { employee: { $in: empIds } }) } },
        { $group: { _id: null, total: { $sum: '$totalDistance' } } }
      ]),
      Lead.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Leave.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
      Task.countDocuments(isSuperAdmin ? {} : { employee: { $in: empIds } }),
    ]);

    const absentCount = Math.max(0, totalEmployees - presentCount);
    const attendanceRate = totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 0;

    const monthlyMeetings = await Meeting.aggregate([
      ...(isSuperAdmin ? [] : [{ $match: { employee: { $in: empIds } } }]),
      { $group: { _id: { $month: '$date' }, count: { $sum: 1 } } },
      { $sort: { '_id': 1 } }
    ]);

    const expenseByCategory = await Expense.aggregate([
      { $match: { status: 'approved', ...(isSuperAdmin ? {} : { employee: { $in: empIds } }) } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);

    const stats = {
      totalEmployees,
      activeEmployees,
      trackingNow,
      todayAttendance: presentCount,
      presentEmployees: presentCount,
      absentEmployees: absentCount,
      lateEmployees: lateCount,
      halfDayEmployees: halfDayCount,
      attendanceRate,
      totalMeetings,
      todayMeetings,
      pendingExpenses,
      totalExpenses: totalExpenses[0]?.total || 0,
      totalKm: totalKmData[0]?.total || 0,
      totalLeads: totalLeads || 0,
      totalLeaves: totalLeaves || 0,
      totalTasks: totalTasks || 0,
      monthlyMeetings,
      expenseByCategory,
    };

    await liveCache.set(cacheKey, stats, 30);

    res.json({
      success: true,
      stats
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllEmployees = async (req, res) => {
  try {
    const { page = 1, limit = 100, search, department, isActive, role } = req.query;
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const filter = {};
    if (!isSuperAdmin && orgId) {
      filter.organizationId = orgId;
    }

    if (userRole === 'MANAGER') {
      filter.$or = [{ managerId: req.user._id }, { manager: req.user._id }, { _id: req.user._id }];
    }

    if (role && role !== 'all') {
      filter.role = role;
    } else if (!isSuperAdmin) {
      filter.role = { $nin: ['super_admin', 'SUPER_ADMIN', 'org_admin', 'ORG_ADMIN'] };
    }

    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ name: searchRegex }, { email: searchRegex }, { employeeId: searchRegex }] }
        ];
        delete filter.$or;
      } else {
        filter.$or = [
          { name: searchRegex },
          { email: searchRegex },
          { employeeId: searchRegex },
        ];
      }
    }

    if (department) filter.department = department;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const employees = await User.find(filter)
      .populate('manager', 'name')
      .sort({ isTracking: -1, isOnline: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const total = await User.countDocuments(filter);

    // Enrich employees with today's real attendance distance and live location metrics
    const empIds = employees.map(e => e._id);
    const today = new Date().toISOString().slice(0, 10);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todayAttendances, todayLiveLocations] = await Promise.all([
      Attendance.find({ 
        employee: { $in: empIds }, 
        $or: [{ date: today }, { createdAt: { $gte: startOfToday } }] 
      }).lean(),
      LiveLocation.find({ 
        employee: { $in: empIds }, 
        $or: [{ date: today }, { createdAt: { $gte: startOfToday } }, { isActive: true }] 
      }).lean()
    ]);

    const attMap = new Map();
    todayAttendances.forEach(a => {
      const empKey = String(a.employee);
      const existing = attMap.get(empKey);
      if (!existing || (a.totalDistanceTraveled || 0) > (existing.totalDistanceTraveled || 0)) {
        attMap.set(empKey, a);
      }
    });

    const empSessionsDistMap = new Map();
    const liveMap = new Map();

    todayLiveLocations.forEach(l => {
      const empKey = String(l.employee);
      const sessionDist = Number(l.totalDistance) || Number(l.officialDistance) || Number(l.acceptedDistance) || 0;
      empSessionsDistMap.set(empKey, (empSessionsDistMap.get(empKey) || 0) + sessionDist);

      const existing = liveMap.get(empKey);
      if (!existing || (l.isActive && !existing.isActive) || (new Date(l.updatedAt || 0) > new Date(existing.updatedAt || 0))) {
        liveMap.set(empKey, l);
      }
    });

    const enrichedEmployees = employees.map(e => {
      const empObj = e.toObject ? e.toObject() : { ...e };
      const empIdStr = String(empObj._id);
      const att = attMap.get(empIdStr);
      const live = liveMap.get(empIdStr);

      const isLive = live?.isActive === true || empObj.isTracking === true;
      const todayKm = Math.round(Math.max(
        Number(att?.totalDistanceTraveled) || 0,
        empSessionsDistMap.get(empIdStr) || 0,
        Number(live?.totalDistance) || 0,
        Number(live?.officialDistance) || 0
      ) * 100) / 100;

      const lastPingTime = live?.lastActivity || live?.updatedAt || att?.checkIn || empObj.lastSeen || empObj.updatedAt;

      return {
        ...empObj,
        isTracking: isLive,
        isLive,
        totalDistance: todayKm,
        totalDistanceToday: todayKm,
        lastPing: lastPingTime,
        lastCheckIn: att?.checkIn || empObj.lastCheckIn,
        attendanceStatus: att?.status || (isLive ? 'present' : 'absent'),
        currentAddress: live?.currentAddress || live?.endAddress || live?.startAddress || empObj.address
      };
    });

    res.json({ success: true, employees: enrichedEmployees, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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
    const updateData = { ...req.body };
    if (updateData.emp_profile_pic) {
      updateData.avatar = updateData.emp_profile_pic;
    } else if (updateData.managerPro_pic) {
      updateData.avatar = updateData.managerPro_pic;
    } else if (updateData.avatar) {
      updateData.emp_profile_pic = updateData.avatar;
      updateData.managerPro_pic = updateData.avatar;
    }
    const employee = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, employee });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getManagers = async (req, res) => {
  try {
    const userRole = (req.user?.role || '').toUpperCase();
    const isSuperAdmin = ['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole);
    const orgId = req.user?.organizationId?._id || req.user?.organizationId;

    const filter = { role: { $in: ['manager', 'MANAGER'] } };
    if (!isSuperAdmin && orgId) {
      filter.organizationId = orgId;
    }

    const managers = await User.find(filter).select('name email designation employeeId department role allocatedArea address isActive isOnline isTracking isApproved isBlocked salary TA').sort({ name: 1 });
    res.json({ success: true, managers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Helper to scope employee IDs by tenant and role
const getScopedEmployeeIds = async (user) => {
  const userRole = (user?.role || '').toUpperCase();
  if (['SUPER_ADMIN', 'SUPERADMIN'].includes(userRole)) return null;

  const orgId = user?.organizationId?._id || user?.organizationId;
  const userScope = { organizationId: orgId };
  if (userRole === 'MANAGER') {
    userScope.$or = [{ managerId: user._id }, { manager: user._id }, { _id: user._id }];
  } else if (userRole === 'EMPLOYEE') {
    userScope._id = user._id;
  }

  const scopedUsers = await User.find(userScope).select('_id');
  return scopedUsers.map(u => u._id);
};

exports.approveExpense = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const expense = await Expense.findByIdAndUpdate(req.params.id, {
      status, approvedBy: req.user._id, approvedAt: new Date(),
      ...(rejectionReason && { rejectionReason })
    }, { new: true }).populate('employee', 'name socketId');
    
    const io = req.app.get('io');
    if (expense?.employee?.socketId) {
      io.to(expense.employee.socketId).emit('expense_status_update', { expenseId: expense._id, status });
    }
    res.json({ success: true, expense });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getAllMeetings = async (req, res) => {
  try {
    const { page = 1, limit = 20, employeeId, status } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, meetings: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

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

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, expenses: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (status) filter.status = status;
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

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, records: [] });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (date) filter.date = date;
    const records = await Attendance.find(filter).populate('employee', 'name employeeId department').sort({ date: -1 });
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getTrackingHistory = async (req, res) => {
  try {
    const { employeeId, date, startDate, endDate, page = 1, limit = 100 } = req.query;
    const filter = {};

    const scopedIds = await getScopedEmployeeIds(req.user);
    if (scopedIds !== null) {
      if (employeeId) {
        if (!scopedIds.some(id => String(id) === String(employeeId))) {
          return res.json({ success: true, history: [], total: 0, pages: 0 });
        }
        filter.employee = employeeId;
      } else {
        filter.employee = { $in: scopedIds };
      }
    } else if (employeeId) {
      filter.employee = employeeId;
    }

    if (startDate && endDate) {
      if (startDate === endDate) {
        filter.$or = [{ date: startDate }, { isActive: true }];
      } else {
        filter.$or = [{ date: { $gte: startDate, $lte: endDate } }, { isActive: true }];
      }
    } else if (date) {
      filter.$or = [{ date: date }, { isActive: true }];
    }

    const trackingController = require('./tracking.controller');
    const history = await LiveLocation.find(filter, { 
      coordinates: { $slice: -1 }
    })
      .populate('employee', 'name employeeId department avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit);

    const targetDateStr = date || startDate || new Date().toISOString().slice(0, 10);
    const startOfTarget = new Date(`${targetDateStr}T00:00:00.000Z`);
    const endOfTarget = new Date(`${targetDateStr}T23:59:59.999Z`);

    // Auto-recalculate 0.0 KM sessions and isolate date-specific KM
    if (Array.isArray(history)) {
      const { DistanceLedger } = require('../models/index');
      for (const s of history) {
        if (!s.totalDistance || s.totalDistance === 0) {
          try {
            const recalculated = await trackingController.recalculateSessionFromPoints(s.sessionId);
            if (recalculated > 0) {
              s.totalDistance = recalculated;
              s.officialDistance = recalculated;
            }
          } catch (_) {}
        }

        const sessionDateStr = s.date || (s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : targetDateStr);
        if (sessionDateStr !== targetDateStr || (s.startTime && new Date(s.startTime) < startOfTarget)) {
          try {
            const ledgerAgg = await DistanceLedger.aggregate([
              {
                $match: {
                  sessionId: s.sessionId,
                  classification: { $in: ['ACCEPTED', 'RECOVERED', 'CANDIDATE'] },
                  toTimestamp: { $gte: startOfTarget, $lte: endOfTarget }
                }
              },
              { $group: { _id: null, totalKm: { $sum: '$distanceKm' } } }
            ]);

            const dateSpecificKm = Math.round((ledgerAgg[0]?.totalKm || 0) * 100) / 100;
            if (s.toObject) {
              s.totalDistance = dateSpecificKm;
              s.officialDistance = dateSpecificKm;
            } else {
              s.totalDistance = dateSpecificKm;
              s.officialDistance = dateSpecificKm;
            }
          } catch (_) {}
        }
      }
    }

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

// @desc Get organization profile & settings
exports.getOrganizationSettings = async (req, res) => {
  try {
    const Organization = require('../models/Organization.model');
    let orgId = req.organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    let organization = null;
    if (orgId) {
      organization = await Organization.findById(orgId);
    }
    if (!organization) {
      organization = await Organization.findOne();
    }
    if (!organization) return res.status(404).json({ success: false, message: 'Organization record not found' });
    res.json({ success: true, organization });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update organization profile & settings
exports.updateOrganizationSettings = async (req, res) => {
  try {
    const Organization = require('../models/Organization.model');
    let orgId = req.organizationId || req.user?.organizationId?._id || req.user?.organizationId;
    if (!orgId) {
      const existing = await Organization.findOne();
      if (existing) orgId = existing._id;
    }
    if (!orgId) return res.status(404).json({ success: false, message: 'Organization record not found' });
    const { name, phone, email, address, settings, logo, Org_logo, companyLogo } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (email) updateData.email = email;
    if (address) updateData.address = address;
    if (settings) updateData.settings = settings;

    const chosenLogo = Org_logo !== undefined ? Org_logo : (companyLogo !== undefined ? companyLogo : logo);
    if (chosenLogo !== undefined) {
      updateData.logo = chosenLogo;
      updateData.Org_logo = chosenLogo;
      updateData.companyLogo = chosenLogo;
    }

    const organization = await Organization.findByIdAndUpdate(
      orgId,
      { $set: updateData },
      { new: true }
    );
    res.json({ success: true, organization, message: 'Organization settings updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

