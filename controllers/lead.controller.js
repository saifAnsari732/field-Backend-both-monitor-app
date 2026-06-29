const { Lead, Notification } = require('../models/index');

// @desc Create lead (Admin)
exports.createLead = async (req, res) => {
  try {
    const lead = await Lead.create(req.body);
    
    if (lead.assignedTo) {
      const io = req.app.get('io');
      io.to(`user_${lead.assignedTo}`).emit('notification', {
        title: 'New Lead Assigned',
        message: `You have been assigned a new lead: ${lead.name}`,
        type: 'lead',
        data: { leadId: lead._id }
      });

      await Notification.create({
        recipient: lead.assignedTo,
        sender: req.user._id,
        type: 'lead', // changed from 'task' to 'lead' for proper routing
        title: 'New Lead Assigned',
        message: `You have been assigned a new lead: ${lead.name}`,
        data: { leadId: lead._id }
      });
    }

    res.status(201).json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get leads (Admin sees all, Employee sees assigned)
exports.getLeads = async (req, res) => {
  try {
    const filter = ['admin', 'hr'].includes(req.user.role) ? {} : { assignedTo: req.user._id };
    const leads = await Lead.find(filter).populate('assignedTo', 'name email').sort('-createdAt');
    res.json({ success: true, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Update lead status/feedback (Employee)
exports.updateLead = async (req, res) => {
  try {
    const { status, feedback } = req.body;
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { status, feedback, lastContacted: new Date() },
      { new: true }
    );
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Delete lead
exports.deleteLead = async (req, res) => {
  try {
    await Lead.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Lead deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
