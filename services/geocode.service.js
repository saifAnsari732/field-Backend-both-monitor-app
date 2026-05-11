const fetch = require('node-fetch');

const reverseGeocode = async (lat, lng) => {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
      headers: { 'User-Agent': 'FieldCRM-Tracker/1.0' }
    });
    const data = await response.json();
    if (data.address) {
      const a = data.address;
      const parts = [
        a.road || a.neighbourhood || a.suburb || '',
        a.city || a.town || a.village || a.county || '',
        a.state || '',
        a.postcode || '',
      ].filter(Boolean);
      return parts.join(', ');
    }
    return data.display_name || 'Unknown Location';
  } catch (err) {
    console.error('Geocoding error:', err);
    return 'Address Unavailable';
  }
};

module.exports = { reverseGeocode };
