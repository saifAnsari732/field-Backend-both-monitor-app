const mongoose = require('mongoose');

const tripRouteClaimSchema = new mongoose.Schema({
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Organization', 
    required: true 
  },
  employee: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  date: { 
    type: String, 
    required: true 
  }, // YYYY-MM-DD
  origin: {
    address: { type: String, required: true },
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
  },
  destination: {
    address: { type: String, required: true },
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
  },
  distanceKm: { 
    type: Number, 
    required: true,
    min: 0
  },
  durationMins: { 
    type: Number, 
    default: 0 
  },
  ratePerKm: { 
    type: Number, 
    default: 2.50 
  },
  reimbursementAmount: { 
    type: Number, 
    default: 0 
  },
  purpose: { 
    type: String, 
    default: 'Client Meeting Travel' 
  },
  meetingId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Meeting', 
    default: null 
  },
  clientName: { 
    type: String, 
    default: '' 
  },
  polyline: [{
    latitude:  Number,
    longitude: Number,
  }],
  status: { 
    type: String, 
    enum: ['credited', 'pending', 'rejected'], 
    default: 'credited' 
  },
  creditedAt: { 
    type: Date, 
    default: Date.now 
  },
}, { timestamps: true });

tripRouteClaimSchema.index({ organizationId: 1, employee: 1, date: -1 });
tripRouteClaimSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('TripRouteClaim', tripRouteClaimSchema);
