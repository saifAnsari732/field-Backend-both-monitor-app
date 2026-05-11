const fetch = require('node-fetch');

// Simple in-memory cache to reduce external calls
const geocodeCache = new Map();
const REQUEST_INTERVAL = 1100; // 1.1s to be safe (Nominatim limit is 1s)
let lastRequestTime = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const reverseGeocode = async (lat, lng) => {
  const cacheKey = `${parseFloat(lat).toFixed(5)},${parseFloat(lng).toFixed(5)}`;
  
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  // Throttle requests to Nominatim
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < REQUEST_INTERVAL) {
    await sleep(REQUEST_INTERVAL - timeSinceLast);
  }
  lastRequestTime = Date.now();

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'FieldCRM-Admin-Proxy-System' }
    });
    
    if (response.status === 429) {
      console.warn('Nominatim rate limit hit, falling back to coordinates');
      return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
    }

    const data = await response.json();
    let result = `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;

    if (data.address) {
      const a = data.address;
      const parts = [
        a.house_number || a.building || '',
        a.road || a.neighbourhood || a.suburb || '',
        a.city || a.town || a.village || a.county || '',
        a.state || '',
      ].filter(Boolean);
      
      if (parts.length > 0) result = parts.join(', ');
      else if (data.display_name) result = data.display_name;
    }

    // Cache the result
    geocodeCache.set(cacheKey, result);
    // Limit cache size
    if (geocodeCache.size > 2000) {
      const firstKey = geocodeCache.keys().next().value;
      geocodeCache.delete(firstKey);
    }

    return result;
  } catch (err) {
    console.error('Geocoding error:', err);
    return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
  }
};

module.exports = { reverseGeocode };
