const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const { liveCache } = require('../services/cache.service');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }

  try {
    const cacheKey = `auth_user_${decoded.id}`;
    let user = await liveCache.get(cacheKey);
    if (!user) {
      const dbUser = await User.findById(decoded.id).select('-password').lean();
      if (dbUser) {
        user = dbUser;
        await liveCache.set(cacheKey, user, 45);
      }
    }
    req.user = user;
    if (!req.user) return res.status(401).json({ success: false, message: 'User not found' });
    if (req.user.isBlocked) return res.status(403).json({ success: false, message: 'Account blocked' });
    next();
  } catch (dbErr) {
    return res.status(503).json({ success: false, message: 'Temporary database error, please retry' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !req.user.role) {
    return res.status(403).json({ success: false, message: 'Access denied: No user role' });
  }

  const userRole = req.user.role.toUpperCase();
  const allowedRoles = roles.map(r => r.toUpperCase());

  // Super admin & Org admin bypass all management endpoints
  if (['SUPER_ADMIN', 'SUPERADMIN', 'ORG_ADMIN', 'ORGADMIN'].includes(userRole)) {
    return next();
  }

  // Managers/HR can access administrative/management endpoints
  if (userRole === 'MANAGER' || userRole === 'HR') {
    if (allowedRoles.includes('MANAGER') || allowedRoles.includes('ADMIN') || allowedRoles.includes('HR') || allowedRoles.includes('ALL')) {
      return next();
    }
  }

  if (allowedRoles.includes(userRole) || allowedRoles.includes('ALL')) {
    return next();
  }

  if (roles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({ success: false, message: 'Access denied' });
};

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

module.exports = { protect, authorize, generateToken };
