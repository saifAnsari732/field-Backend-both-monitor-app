const fetch = require('node-fetch');

// 📏 Haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 1. Search places using Google Places Autocomplete API
 * Fallback to OpenStreetMap Nominatim if Google fails
 */
async function searchPlaces(query, lat = null, lng = null) {
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return [];
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const cleanQuery = query.trim();

  // Try Google Places Autocomplete
  if (apiKey) {
    try {
      let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(cleanQuery)}&key=${apiKey}&components=country:in&language=en`;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        url += `&location=${lat},${lng}&radius=50000`;
      }

      const res = await fetch(url);
      const data = await res.json();

      if (data.status === 'OK' && Array.isArray(data.predictions)) {
        return data.predictions.map((p) => ({
          placeId: p.place_id,
          title: p.structured_formatting?.main_text || p.description.split(',')[0],
          subtitle: p.structured_formatting?.secondary_text || p.description,
          description: p.description,
          source: 'google',
        }));
      }
    } catch (err) {
      console.warn('⚠️ [RoutingService] Google Places Autocomplete failed:', err.message);
    }
  }

  // Fallback: OpenStreetMap Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&countrycodes=in&limit=8&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FieldApp-TripPlanner/1.0' },
    });
    const data = await res.json();

    if (Array.isArray(data)) {
      return data.map((item) => ({
        placeId: `osm:${item.place_id}`,
        title: item.name || item.display_name.split(',')[0],
        subtitle: item.display_name,
        description: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        source: 'osm',
      }));
    }
  } catch (err) {
    console.warn('⚠️ [RoutingService] Nominatim search failed:', err.message);
  }

  return [];
}

/**
 * 2. Resolve placeId to exact lat/lng and formatted address
 */
async function getPlaceDetails(placeId) {
  if (!placeId) return null;

  // Handle OSM fallback ID
  if (placeId.startsWith('osm:')) {
    const osmId = placeId.replace('osm:', '');
    try {
      const url = `https://nominatim.openstreetmap.org/details?place_id=${osmId}&format=json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'FieldApp-TripPlanner/1.0' },
      });
      const data = await res.json();
      if (data && data.geometry?.coordinates) {
        return {
          lat: data.geometry.coordinates[1],
          lng: data.geometry.coordinates[0],
          address: data.localname || data.names?.name || 'Selected Location',
        };
      }
    } catch (_) {}
    return null;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry,formatted_address,name&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === 'OK' && data.result?.geometry?.location) {
      return {
        lat: data.result.geometry.location.lat,
        lng: data.result.geometry.location.lng,
        address: data.result.formatted_address || data.result.name,
        name: data.result.name,
      };
    }
  } catch (err) {
    console.warn('⚠️ [RoutingService] Place Details failed:', err.message);
  }

  return null;
}

/**
 * 3. Calculate Driving Route between Origin & Destination
 * Uses OSRM Driving Engine with turn-by-turn road geometry
 * Fallback to interpolated Haversine path if network unreachable
 */
async function calculateDrivingRoute(originLat, originLng, destLat, destLng) {
  const oLat = Number(originLat);
  const oLng = Number(originLng);
  const dLat = Number(destLat);
  const dLng = Number(destLng);

  if (!Number.isFinite(oLat) || !Number.isFinite(oLng) || !Number.isFinite(dLat) || !Number.isFinite(dLng)) {
    throw new Error('Invalid coordinates supplied for route calculation.');
  }

  // 1. Try OSRM Driving Engine
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { timeout: 6000 });
    const data = await res.json();

    if (data.code === 'Ok' && Array.isArray(data.routes) && data.routes.length > 0) {
      const best = data.routes[0];
      const distanceKm = Math.round((best.distance / 1000) * 100) / 100;
      const durationMins = Math.max(1, Math.round(best.duration / 60));

      const polyline = (best.geometry?.coordinates || []).map((coord) => ({
        latitude: coord[1],
        longitude: coord[0],
      }));

      return {
        distanceKm,
        durationMins,
        polyline,
        engine: 'OSRM_DRIVING',
      };
    }
  } catch (osrmErr) {
    console.warn('⚠️ [RoutingService] OSRM routing failed, using geodesic interpolation fallback:', osrmErr.message);
  }

  // 2. Geodesic + Indian Road Factor Fallback (Haversine * 1.32 for urban/rural road winding)
  const straightMeters = haversineMeters(oLat, oLng, dLat, dLng);
  const roadFactor = 1.32;
  const distanceKm = Math.round(((straightMeters * roadFactor) / 1000) * 100) / 100;
  // Estimate speed at 28 km/h in Indian cities/semi-urban areas
  const durationMins = Math.max(1, Math.round((distanceKm / 28) * 60));

  // Generate 20 interpolated points for smooth rendering
  const polyline = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    polyline.push({
      latitude: oLat + (dLat - oLat) * t,
      longitude: oLng + (dLng - oLng) * t,
    });
  }

  return {
    distanceKm,
    durationMins,
    polyline,
    engine: 'GEODESIC_ROAD_ESTIMATE',
  };
}

module.exports = {
  searchPlaces,
  getPlaceDetails,
  calculateDrivingRoute,
  haversineMeters,
};
