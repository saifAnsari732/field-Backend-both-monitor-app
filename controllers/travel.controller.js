const { TravelLog } = require('../models/index');

// @desc Create travel log (Employee)
exports.createTravelLog = async (req, res) => {
  try {
    const travelLog = await TravelLog.create({
      ...req.body,
      employee: req.user._id
    });
    res.status(201).json({ success: true, travelLog });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get travel logs
exports.getTravelLogs = async (req, res) => {
  try {
    const filter = req.user.role === 'admin' 
      ? (req.query.employeeId ? { employee: req.query.employeeId } : {}) 
      : { employee: req.user._id };
    
    const logs = await TravelLog.find(filter)
      .populate('employee', 'name employeeId')
      .sort('-date');
    
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete travel log
exports.deleteTravelLog = async (req, res) => {
  try {
    await TravelLog.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Travel log deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
