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
      employeeId, role: 'employee', isApproved: true,
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

// Build a regex that matches a stored phone number regardless of formatting
// (spaces, dashes, +91 / 0 prefix) using its last 10 digits.
const phoneRegexFromDigits = (last10) =>
  new RegExp(last10.split('').join('\\D*') + '\\D*$');

// @desc Login — accepts email OR phone number (employee / manager / admin / org admin)
exports.login = async (req, res) => {
  try {
    const { email, identifier, phone, mobile, password } = req.body;
    const rawId = String(identifier || email || phone || mobile || '').trim();
    if (!rawId || !password)
      return res.status(400).json({ success: false, message: 'Email/Phone and password are required' });

    let candidates = [];
    if (rawId.includes('@')) {
      candidates = await User.find({ email: rawId.toLowerCase() })
        .populate('manager', 'name email').populate('organizationId');
    } else {
      const digits = rawId.replace(/\D/g, '');
      const orClauses = [];
      if (digits.length >= 10) {
        const last10 = digits.slice(-10);
        orClauses.push({ phone: { $regex: phoneRegexFromDigits(last10) } });
        orClauses.push({ phone: last10 });
        if (!isNaN(Number(last10))) {
          orClauses.push({ phone: Number(last10) });
        }
      }
      orClauses.push({ phone: rawId });
      orClauses.push({ employeeId: { $regex: new RegExp(`^${rawId.trim()}$`, 'i') } });
      orClauses.push({ email: rawId.toLowerCase() });

      candidates = await User.find({ $or: orClauses })
        .populate('manager', 'name email').populate('organizationId');
    }

    // Same phone may exist on more than one account: pick the one whose password matches
    let user = null;
    for (const c of candidates) {
      if (await c.matchPassword(password)) { user = c; break; }
    }
    if (!user)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account blocked. Contact HR.' });


    await User.findByIdAndUpdate(user._id, { isOnline: true, lastSeen: new Date() });
    await ActivityLog.create({ employee: user._id, action: 'LOGIN', description: `User logged in (${rawId.includes('@') ? 'email' : 'phone'})`, ip: req.ip });

    const token = generateToken(user._id);
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Refresh Token (Supports refreshing expired JWT tokens safely)
exports.refreshToken = async (req, res) => {
  try {
    const rawToken = req.body?.refreshToken || req.headers?.authorization?.replace('Bearer ', '') || req.body?.token;
    if (!rawToken) {
      return res.status(401).json({ success: false, message: 'Token required for refresh' });
    }

    let userId = req.user?._id;
    if (!userId) {
      try {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET, { ignoreExpiration: true });
        userId = decoded.id;
      } catch (e) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
      }
    }

    const user = await User.findById(userId).populate('organizationId');
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
      isOnline: false, lastSeen: new Date(), socketId: null
    });
    await ActivityLog.create({ employee: req.user._id, action: 'LOGOUT', description: 'User logged out' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Get current user
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user._id).populate('manager', 'name email avatar').populate('organizationId');
  res.json({ success: true, user });
};

// @desc Update profile
exports.updateProfile = async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'avatar', 'emp_profile_pic', 'managerPro_pic', 'emergencyContact', 'fcmToken', 'daReceipt', 'DA'];

    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    // Sync avatar & role-specific profile pic
    const userRole = (req.user.role || '').toUpperCase();
    if (updates.emp_profile_pic) {
      updates.avatar = updates.emp_profile_pic;
    }
    if (updates.managerPro_pic) {
      updates.avatar = updates.managerPro_pic;
    }
    if (updates.avatar && !updates.emp_profile_pic && !updates.managerPro_pic) {
      if (userRole === 'MANAGER') {
        updates.managerPro_pic = updates.avatar;
      } else {
        updates.emp_profile_pic = updates.avatar;
      }
    }

    const updateDoc = {};

    // DA increment (total)
    if (updates.DA !== undefined) {
      const inc = Number(updates.DA);
      updateDoc.$inc = { DA: Number.isNaN(inc) ? 0 : inc };
      delete updates.DA;
    }

    // DA history: har upload ke saath daReceipt aata hai
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

// Helper: Find user by email, phone number, or employeeId
async function findUserByIdentifier(rawInput) {
  const rawId = String(rawInput || '').trim();
  if (!rawId) return null;

  if (rawId.includes('@')) {
    return User.findOne({ email: rawId.toLowerCase() });
  }

  const digits = rawId.replace(/\D/g, '');
  const orClauses = [];
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    orClauses.push({ phone: { $regex: phoneRegexFromDigits(last10) } });
    orClauses.push({ phone: last10 });
    if (!isNaN(Number(last10))) {
      orClauses.push({ phone: Number(last10) });
    }
  }
  orClauses.push({ phone: rawId });
  orClauses.push({ employeeId: { $regex: new RegExp(`^${rawId}$`, 'i') } });
  orClauses.push({ email: rawId.toLowerCase() });

  return User.findOne({ $or: orClauses });
}

// @desc Step 1 of Forgot Password: Verify registered email or phone number
exports.verifyResetEmail = async (req, res) => {
  try {
    const rawId = req.body?.email || req.body?.identifier || req.body?.phone || '';
    if (!String(rawId).trim()) {
      return res.json({ success: false, message: 'Please enter your registered email address or mobile number.' });
    }

    const user = await findUserByIdentifier(rawId);
    if (!user) {
      return res.json({ success: false, message: 'No registered account found with this email or mobile number.' });
    }
    if (user.isBlocked) {
      return res.json({ success: false, message: 'Account is blocked. Please contact your administrator.' });
    }

    return res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// @desc Step 2 of Forgot Password: Reset password directly after account verification
exports.resetPasswordDirect = async (req, res) => {
  try {
    const rawId = req.body?.email || req.body?.identifier || req.body?.phone || '';
    const { newPassword } = req.body || {};

    if (!String(rawId).trim() || !newPassword) {
      return res.json({ success: false, message: 'Email/phone and new password are required.' });
    }
    if (String(newPassword).length < 6) {
      return res.json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const user = await findUserByIdentifier(rawId);
    if (!user) {
      return res.json({ success: false, message: 'Account not found.' });
    }
    if (user.isBlocked) {
      return res.json({ success: false, message: 'Account is blocked. Please contact your administrator.' });
    }

    user.password = newPassword;
    await user.save();

    await ActivityLog.create({
      employee: user._id,
      action: 'PASSWORD_RESET',
      description: 'Password reset via self-service verification',
      ip: req.ip,
    }).catch(() => {});

    return res.json({
      success: true,
      message: 'Password updated successfully! You can now sign in.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

