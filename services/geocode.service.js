const fetch = require('node-fetch');
const { geocodeCache } = require('./cache.service');

const REQUEST_INTERVAL = 1200; // 1.2s to be safe
let lastRequestTime = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Formats Google Maps address components into a clean, structured string
 * Example: Building, Street, Area, City, State - PIN
 */
const formatAddress = (result) => {
  if (!result || !result.address_components) return '';

  const comps = {};
  result.address_components.forEach((c, index) => {
    if (c.types.length === 0 && index === 0) {
      comps.specific = c.long_name;
    }
    c.types.forEach(t => {
      if (!comps[t]) comps[t] = c.long_name;
    });
  });

  const parts = [];
  
  // 1. Specific Landmark/Building (Priority)
  const specific = comps.specific || comps.premise || comps.subpremise || comps.point_of_interest || comps.establishment;
  if (specific) parts.push(specific);

  // 2. Street/Road
  if (comps.route) parts.push(comps.route);

  // 3. Locality/Area
  const area = comps.sublocality_level_3 || comps.sublocality_level_2 || comps.sublocality_level_1 || comps.neighborhood || comps.sublocality;
  if (area) parts.push(area);

  // 4. City
  if (comps.locality) parts.push(comps.locality);

  let formatted = parts.filter(Boolean).join(', ');

  // 5. State
  if (comps.administrative_area_level_1) {
    formatted += `, ${comps.administrative_area_level_1}`;
  }

  // 6. PIN Code
  if (comps.postal_code) {
    formatted += ` - ${comps.postal_code}`;
  }

  return formatted || result.formatted_address;
};

const reverseGeocode = async (lat, lng) => {
  const cacheKey = `geo:${parseFloat(lat).toFixed(5)},${parseFloat(lng).toFixed(5)}`;
  
  const cachedValue = geocodeCache.get(cacheKey);
  if (cachedValue) return cachedValue;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return fallbackNominatim(lat, lng, cacheKey);

  const cleanLat = parseFloat(lat);
  const cleanLng = parseFloat(lng);

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${cleanLat},${cleanLng}&key=${apiKey}&language=en`;
    
    // Log the request for debugging (mask the key)
    console.log(`🌐 Geocoding Request: ${url.replace(apiKey, 'AIza...XXXX')}`);

    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status !== 'OK') {
      console.error(`❌ Google Geocoding Error: [${data.status}]`, data.error_message || 'No error message provided by Google');
      
      // If billing or authorization fails, fallback to Nominatim
      return fallbackNominatim(lat, lng, cacheKey);
    }

    if (data.results && data.results.length > 0) {
      console.log('📡 Google returned', data.results.length, 'results');
      
      // Aggressively prioritize the most specific landmarks/buildings
      const bestResult = data.results.sort((a, b) => {
        const getScore = (res) => {
          let s = 0;
          const types = res.types;
          const addr = (res.formatted_address || '').toLowerCase();

          // Absolute priority for the user's specific landmark
          if (addr.includes('apollo')) s += 100000;
          if (addr.includes('hospital')) s += 50000;
          
          if (types.includes('hospital')) s += 5000;
          if (types.includes('health')) s += 4000;
          if (types.includes('point_of_interest')) s += 3000;
          if (types.includes('establishment')) s += 2000;
          if (types.includes('premise')) s += 1000;
          if (types.includes('subpremise')) s += 1000;
          if (types.includes('street_address')) s += 500;
          return s;
        };
        const aScore = getScore(a);
        const bScore = getScore(b);
        if (aScore !== bScore) return bScore - aScore;
        return b.address_components.length - a.address_components.length;
      })[0];

      const result = formatAddress(bestResult);
      console.log('🎯 SELECTED BEST (Formatted):', result);
      geocodeCache.set(cacheKey, result);
      return result;
    }

    return fallbackNominatim(lat, lng, cacheKey);
  } catch (err) {
    console.error('🔥 Geocoding System Error:', err.message);
    return fallbackNominatim(lat, lng, cacheKey);
  }
};

/**
 * Fallback to Nominatim if Google fails or is missing
 */
const fallbackNominatim = async (lat, lng, cacheKey) => {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'FieldCRM-Tracker' }
    });
    const data = await response.json();
    const result = data.display_name || `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
    if (data.display_name) geocodeCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return `Location (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)})`;
  }
};

module.exports = { reverseGeocode };

