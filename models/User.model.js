const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true, minlength: 6 },
    role: {
      type: String,
      enum: ["employee", "admin", "hr"],
      default: "employee",
    },
    employeeId: { type: String, unique: true },
    phone: { type: String },
    avatar: { type: String, default: "" },
    department: { type: String },
    designation: { type: String },
    joiningDate: { type: Date },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    emergencyContact: {
      name: String,
      phone: String,
      relation: String,
    },
    isActive: { type: Boolean, default: true },
    isBlocked: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false },
    isTracking: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date },
    socketId: { type: String },
    fcmToken: { type: String },
    // Management Fields
    salary: { type: Number, default: 0 },
    TA: { type: Number, default: 0 }, // Travel Allowance
    DA: { type: Number, default: 0 }, // Daily Allowance
    allocatedArea: { type: String, default: "" },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
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
