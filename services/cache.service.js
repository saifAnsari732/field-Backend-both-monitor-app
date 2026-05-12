const NodeCache = require('node-cache');

// TTL of 60 seconds by default for live data
// Check period of 120 seconds
const liveCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Longer TTL for geocode cache
const geocodeCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

module.exports = {
  liveCache,
  geocodeCache
};
