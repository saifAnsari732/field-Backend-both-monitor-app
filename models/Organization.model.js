const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    logo: { type: String, default: '' },
    Org_logo: { type: String, default: '' },
    companyLogo: { type: String, default: '' },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    address: {
      street: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
      country: { type: String, default: 'India' },
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'trial', 'cancelled'],
      default: 'active',
    },
    plan: {
      planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
      planName: { type: String, default: 'Business Pro' },
      maxEmployees: { type: Number, default: 50 },
      maxManagers: { type: Number, default: 10 },
      startsAt: { type: Date, default: Date.now },
      expiresAt: { type: Date },
    },
    settings: {
      currency: { type: String, default: 'INR' },
      timezone: { type: String, default: 'Asia/Kolkata' },
      minDistanceMeters: { type: Number, default: 10 },
      maxAccuracyMeters: { type: Number, default: 500 },
      trackingIntervalSeconds: { type: Number, default: 30 },
    },
  },
  { timestamps: true }
);

organizationSchema.index({ slug: 1 });
organizationSchema.index({ status: 1 });

organizationSchema.pre('save', function (next) {
  const chosenLogo = this.Org_logo || this.companyLogo || this.logo || '';
  if (chosenLogo) {
    if (!this.Org_logo) this.Org_logo = chosenLogo;
    if (!this.companyLogo) this.companyLogo = chosenLogo;
    if (!this.logo) this.logo = chosenLogo;
  }
  next();
});

module.exports = mongoose.model('Organization', organizationSchema);
