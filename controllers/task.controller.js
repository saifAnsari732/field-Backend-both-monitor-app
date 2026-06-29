const { Task, Notification, ActivityLog } = require('../models/index');
const User = require('../models/User.model');

// @desc Create a new task (admin)
exports.createTask = async (req, res) => {
  try {
    const { title, description, employeeId, dueDate, priority, location, duration } = req.body;

    const targetEmployeeId = employeeId || (req.user.role === 'employee' ? req.user._id : null);
    if (!targetEmployeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    const task = await Task.create({
      title,
      description,
      employee: targetEmployeeId,
      assignedBy: req.user._id,
      dueDate,
      priority,
      location,
      duration
    });

    const employee = await User.findById(targetEmployeeId);
    if (employee) {
      // Notify employee using reliable user room
      const io = req.app.get('io');
      io.to(`user_${targetEmployeeId}`).emit('new_task', { task });

      await Notification.create({
        recipient: targetEmployeeId,
        sender: req.user._id,
        type: 'task',
        title: 'New Task Assigned',
        message: `You have been assigned a new task: ${title}`
      });
    }

    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get my tasks (employee)
exports.getMyTasks = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { employee: req.user._id };
    if (status) filter.status = status;

    const tasks = await Task.find(filter).sort({ dueDate: 1 });
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update task status (employee)
exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, employee: req.user._id },
      { 
        status, 
        ...(status === 'completed' && { completedAt: new Date() }) 
      },
      { new: true }
    ).populate('assignedBy', 'name socketId');

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    // Notify admin
    const io = req.app.get('io');
    io.to('admins').emit('task_status_update', {
      taskId: task._id,
      status,
      employeeName: req.user.name
    });

    await ActivityLog.create({
      employee: req.user._id,
      action: 'TASK_UPDATE',
      description: `Task "${task.title}" updated to ${status}`
    });

    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get all tasks (admin)
exports.getAllTasks = async (req, res) => {
  try {
    const { status, employeeId, priority } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (employeeId) filter.employee = employeeId;
    if (priority) filter.priority = priority;

    const tasks = await Task.find(filter)
      .populate('employee', 'name employeeId department avatar')
      .populate('assignedBy', 'name')
      .sort({ createdAt: -1 });
    
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
