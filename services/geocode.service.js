const fetch = require('node-fetch');

// Simple in-memory cache to reduce external calls
const geocodeCache = new Map();
const REQUEST_INTERVAL = 1200; // 1.2s to be safe
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
    // Using a more unique and descriptive User-Agent as required by Nominatim policy
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
      headers: { 
        'User-Agent': 'FieldCRM-Management-System-Tracker-v1.0 (contact: admin@fieldcrm.com)',
        'Accept-Language': 'en-IN,en;q=0.9'
      }
    });
    
    if (response.status === 429) {
      console.warn('Nominatim rate limit hit, returning coordinates');
      return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
    }

    const data = await response.json();
    let result = null;

    if (data.address) {
      const a = data.address;
      // More aggressive address building
      const parts = [
        a.road || a.pedestrian || a.suburb || a.neighbourhood || '',
        a.city || a.town || a.village || a.district || '',
        a.state || '',
        a.postcode || ''
      ].filter(Boolean);
      
      if (parts.length > 0) {
        result = parts.join(', ');
      } else if (data.display_name) {
        // Fallback to display_name but clean it up (first 3 parts)
        result = data.display_name.split(',').slice(0, 3).join(',').trim();
      }
    }

    if (result) {
      geocodeCache.set(cacheKey, result);
      if (geocodeCache.size > 2000) {
        const firstKey = geocodeCache.keys().next().value;
        geocodeCache.delete(firstKey);
      }
      return result;
    }

    return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
  } catch (err) {
    console.error('Geocoding error:', err);
    return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
  }
};

module.exports = { reverseGeocode };
