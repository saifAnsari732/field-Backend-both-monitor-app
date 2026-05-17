const User = require('../models/User.model');
const { ActivityLog } = require('../models/index');
const { generateToken } = require('../middleware/auth.middleware');
const { v4: uuidv4 } = require('uuid');

// @desc Register employee
exports.register = async (req, res) => {
  try {
    const { name, email, password, phone, department, designation } = req.body;
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, message: 'Email already registered' });

    const employeeId = 'EMP-' + uuidv4().slice(0, 8).toUpperCase();
    const user = await User.create({
      name, email, password, phone, department, designation,
      employeeId, role: 'employee', isApproved: false,
    });

    await ActivityLog.create({ employee: user._id, action: 'REGISTER', description: 'New employee registered' });

    // Notify admins via socket
    const io = req.app.get('io');
    io.to('admins').emit('new_employee_registered', { employee: user });

    res.status(201).json({ success: true, message: 'Registration submitted. Awaiting admin approval.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).populate('manager', 'name email');
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account blocked. Contact HR.' });
    if (!user.isApproved && user.role === 'employee')
      return res.status(403).json({ success: false, message: 'Account pending approval.' });

    await User.findByIdAndUpdate(user._id, { isOnline: true, lastSeen: new Date() });
    await ActivityLog.create({ employee: user._id, action: 'LOGIN', description: 'User logged in', ip: req.ip });

    const token = generateToken(user._id);
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Refresh Token
exports.refreshToken = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    if (user.isBlocked) {
      return res.status(403).json({ success: false, message: 'Account blocked' });
    }

    const token = generateToken(user._id);
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Logout
exports.logout = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      isOnline: false, isTracking: false, lastSeen: new Date(), socketId: null
    });
    await ActivityLog.create({ employee: req.user._id, action: 'LOGOUT', description: 'User logged out' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get current user
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user._id).populate('manager', 'name email avatar');
  res.json({ success: true, user });
};

// @desc Update profile
exports. updateProfile = async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'avatar', 'emergencyContact', 'fcmToken', 'daReceipt', 'DA'];

    // DA mode: har upload par DA add hona chahiye (replace nahi)
    // payload.DA ko increment samjha jayega
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const updateDoc = {};

    // DEBUG: DA payload aur updateDoc kya banta hai
    // console.log('updateProfile req.body:', req.body);

    // DA increment (total)
    if (updates.DA !== undefined) {
      const inc = Number(updates.DA);
      updateDoc.$inc = { DA: Number.isNaN(inc) ? 0 : inc };
      delete updates.DA;
    }

    // DA history: har upload ke saath daReceipt aata hai
    // (frontend payload me DA increment aur daReceipt url dono bhejta hai)
    if (req.body.DA !== undefined || req.body.daReceipt !== undefined) {
      const amt = Number(req.body.DA);
      const safeAmt = Number.isNaN(amt) ? 0 : amt;

      if (safeAmt > 0 || req.body.daReceipt) {
        updateDoc.$push = {
          daHistory: {
            amount: safeAmt,
            receipt: req.body.daReceipt || '',
            date: new Date(),
          },
        };
      }
    }

    Object.assign(updateDoc, updates);

    console.log('updateProfile req.body:', req.body);
    console.log('updateProfile updateDoc:', updateDoc);

    const user = await User.findByIdAndUpdate(req.user._id, updateDoc, { new: true, runValidators: true });
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Change password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!(await user.matchPassword(currentPassword)))
      return res.status(400).json({ success: false, message: 'Current password incorrect' });
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
