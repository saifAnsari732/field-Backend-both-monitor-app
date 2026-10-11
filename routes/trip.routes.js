const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const tripController = require('../controllers/trip.controller');

// 1. Search places (Google Places Autocomplete + OSM fallback)
router.get('/autocomplete', protect, tripController.searchPlaces);

// 2. Place Details (Resolve Place ID to Coordinates & Address)
router.get('/place-details', protect, tripController.getPlaceDetails);

// 3. Calculate Route (OSRM Driving Engine with distance, duration & polyline)
router.post('/calculate-route', protect, tripController.calculateRoute);

// 4. Confirm Trip & Credit KM to account
router.post('/confirm-trip', protect, tripController.confirmTrip);

// 5. Get personal claimed trips history
router.get('/my-trips', protect, tripController.getMyTrips);

// 6. Get team trips history (Manager / Admin / Org Admin)
router.get('/team-trips', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), tripController.getTeamTrips);

// 7. Update trip claim status (Org Admin / Manager)
router.put('/:id/status', protect, authorize('admin', 'hr', 'manager', 'org_admin', 'super_admin'), tripController.updateTripStatus);

// 8. Delete trip claim (Org Admin only)
router.delete('/:id', protect, authorize('admin', 'org_admin', 'super_admin'), tripController.deleteTripClaim);

module.exports = router;
