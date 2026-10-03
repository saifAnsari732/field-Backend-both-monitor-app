const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    role: {
      type: String,
      enum: [
        "SUPER_ADMIN",
        "ORG_ADMIN",
        "MANAGER",
        "EMPLOYEE",
        "superadmin",
        "admin",
        "hr",
        "manager",
        "employee",
        "agent",
      ],
      default: "EMPLOYEE",
    },
    employeeId: { type: String },
    phone: { type: String },
    avatar: { type: String, default: "" },
    emp_profile_pic: { type: String, default: "" },
    managerPro_pic: { type: String, default: "" },
    department: { type: String },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Department" },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team" },
    teamName: { type: String, default: "" },
    designation: { type: String, default: "" },
    joiningDate: { type: Date },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    managerName: { type: String, default: "" },
    assignedEmployees: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        name: { type: String },
      },
    ],
    emergencyContact: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      relation: { type: String, default: "" },
    },
    address: {
      street: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },
    isActive: { type: Boolean, default: true },
    isBlocked: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: true },
    isTracking: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date },
    socketId: { type: String },
    fcmToken: { type: String },
    mustChangePassword: { type: Boolean, default: false },

    // Financial & Management Fields
    salary: { type: Number, default: 12000 },
    TA: { type: Number, default: 2.50 }, // Travel Allowance per KM
    DA: { type: Number, default: 0 },
    daReceipt: { type: String, default: "" },
    daHistory: [
      {
        amount: { type: Number, default: 0 },
        receipt: { type: String, default: "" },
        date: { type: Date, default: Date.now },
      },
    ],
    allocatedArea: { type: String, default: "Default Area" },
  },
  { timestamps: true }
);

userSchema.index({ organizationId: 1, email: 1 });
userSchema.index({ organizationId: 1, role: 1 });
userSchema.index({ organizationId: 1, managerId: 1 });
userSchema.index({ organizationId: 1, departmentId: 1 });

userSchema.pre("save", async function (next) {
  // Sync avatar with emp_profile_pic / managerPro_pic based on role
  const roleUpper = (this.role || '').toUpperCase();
  if (roleUpper === 'MANAGER') {
    if (this.managerPro_pic && !this.avatar) {
      this.avatar = this.managerPro_pic;
    } else if (this.avatar && !this.managerPro_pic) {
      this.managerPro_pic = this.avatar;
    } else if (this.managerPro_pic && this.isModified('managerPro_pic')) {
      this.avatar = this.managerPro_pic;
    } else if (this.avatar && this.isModified('avatar')) {
      this.managerPro_pic = this.avatar;
    }
  } else {
    // EMPLOYEE / other roles
    if (this.emp_profile_pic && !this.avatar) {
      this.avatar = this.emp_profile_pic;
    } else if (this.avatar && !this.emp_profile_pic) {
      this.emp_profile_pic = this.avatar;
    } else if (this.emp_profile_pic && this.isModified('emp_profile_pic')) {
      this.avatar = this.emp_profile_pic;
    } else if (this.avatar && this.isModified('avatar')) {
      this.emp_profile_pic = this.avatar;
    }
  }

  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model("User", userSchema);
