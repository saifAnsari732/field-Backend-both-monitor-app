const { Meeting, Expense, Task, LiveLocation, Lead } = require('../models/index');
const User = require('../models/User.model');

exports.getConsolidatedReport = async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: 'Employee ID required' });

    const filter = { employee: employeeId };
    // Normalize date inputs. Meetings/expenses use Date objects; LiveLocation stores date as YYYY-MM-DD string
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();
    if (end) end.setHours(23, 59, 59, 999); // Make end date inclusive
    const startStr = start ? start.toISOString().slice(0, 10) : null;
    const endStr = end ? end.toISOString().slice(0, 10) : null;

    const [employee, meetings, expenses, tasks, leads, locations] = await Promise.all([
      User.findById(employeeId).select('name employeeId department designation phone salary TA DA allocatedArea daHistory'),
      Meeting.find({ 
        employee: employeeId, 
        ...(start && { date: { $gte: start, $lte: end } }) 
      }).sort({ date: -1 }),
      Expense.find({ 
        employee: employeeId, 
        ...(start && { date: { $gte: start, $lte: end } }) 
      }).sort({ date: -1 }),
      Task.find({ 
        employee: employeeId, 
        ...(start && { dueDate: { $gte: start, $lte: end } }) 
      }).sort({ dueDate: -1 }),
      Lead.find({ 
        assignedTo: employeeId, 
        ...(start && { createdAt: { $gte: start, $lte: end } }) 
      }).sort({ createdAt: -1 }),
      LiveLocation.find({ 
        employee: employeeId, 
        ...(startStr && { date: { $gte: startStr, $lte: endStr || startStr } }) 
      }).sort({ date: -1 })
    ]);

    const totalKm = locations.reduce((a, b) => a + (b.totalDistance || 0), 0);
    const travelPay = +(totalKm * 2.5).toFixed(2);

    res.json({
      success: true,
      data: {
        employee,
        summary: {
          totalMeetings: meetings.length,
          totalExpenses: expenses.reduce((a, b) => a + b.amount, 0),
          totalTasks: tasks.length,
          totalLeads: leads.length,
          totalKm,
          travelPay
        },
        meetings,
        expenses,
        tasks,
        leads,
        locations
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
