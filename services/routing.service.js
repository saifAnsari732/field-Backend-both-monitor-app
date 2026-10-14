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

// In-memory cache for road distance pairs (1 hour TTL)
const roadDistanceCache = new Map();

function haversineStraightKm(fromLat, fromLng, toLat, toLng) {
  const R = 6371;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Calculates real-world road travel distance from Point A to Point B
 * Uses OSRM Road Network engine with Google Maps fallback & Geodesic Curvature fallback
 * @param {number} fromLat 
 * @param {number} fromLng 
 * @param {number} toLat 
 * @param {number} toLng 
 * @returns {Promise<{ distanceKm: number, source: string, durationMinutes: number }>}
 */
async function getRoadDistance(fromLat, fromLng, toLat, toLng) {
  const fLat = Number(fromLat);
  const fLng = Number(fromLng);
  const tLat = Number(toLat);
  const tLng = Number(toLng);

  if (!Number.isFinite(fLat) || !Number.isFinite(fLng) || !Number.isFinite(tLat) || !Number.isFinite(tLng)) {
    return { distanceKm: 0, source: 'INVALID_COORDS', durationMinutes: 0 };
  }

  const straightDistKm = haversineStraightKm(fLat, fLng, tLat, tLng);

  // Micro-movement (< 60 meters): return straight line distance directly
  if (straightDistKm < 0.060) {
    return {
      distanceKm: Math.round(straightDistKm * 1000) / 1000,
      source: 'STRAIGHT_MICRO',
      durationMinutes: 0
    };
  }

  // Cache key: rounded to ~100m grid for fast reuse
  const cacheKey = `${fLat.toFixed(3)},${fLng.toFixed(3)}_${tLat.toFixed(3)},${tLng.toFixed(3)}`;
  const cached = roadDistanceCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 3600000) {
    return cached.result;
  }

  // 1. Primary: OSRM Driving Road Network API
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fLng},${fLat};${tLng},${tLat}?overview=false`;
    const res = await fetch(url, { timeout: 4000 });
    if (res.ok) {
      const data = await res.json();
      if (data.routes && data.routes[0] && Number.isFinite(data.routes[0].distance)) {
        const roadDistKm = Math.round((data.routes[0].distance / 1000) * 100) / 100;
        const durationMin = Math.round((data.routes[0].duration / 60) * 10) / 10;
        const result = {
          distanceKm: roadDistKm,
          durationMinutes: durationMin,
          source: 'OSRM_ROAD_NETWORK'
        };
        roadDistanceCache.set(cacheKey, { ts: Date.now(), result });
        return result;
      }
    }
  } catch (err) {
    // Network timeout or OSRM unavailable, proceed to fallback
  }

  // 2. Fallback: Haversine with empirical highway/road curve factor (1.20x for straight chords >= 1km)
  const curveFactor = straightDistKm >= 1.0 ? 1.20 : 1.08;
  const fallbackKm = Math.round(straightDistKm * curveFactor * 100) / 100;
  const result = {
    distanceKm: fallbackKm,
    durationMinutes: Math.round((fallbackKm / 40) * 60), // assume 40 km/h average
    source: 'ROAD_CURVATURE_MODEL'
  };
  roadDistanceCache.set(cacheKey, { ts: Date.now(), result });
  return result;
}

/**
 * Computes road distance across an entire sequence of checkpoints (Point A -> Point B -> Point C ...)
 * @param {Array<{lat: number, lng: number, timestamp: Date}>} checkpoints
 * @returns {Promise<{ totalRoadKm: number, segments: Array }>}
 */
async function computeRouteRoadDistance(checkpoints = []) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2) {
    return { totalRoadKm: 0, segments: [] };
  }

  // Filter valid points
  const valid = checkpoints.filter(c => c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)));
  if (valid.length < 2) return { totalRoadKm: 0, segments: [] };

  // Remove redundant stationary cluster points (< 40m apart)
  const distinctStops = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = distinctStops[distinctStops.length - 1];
    const curr = valid[i];
    const distM = haversineStraightKm(prev.lat, prev.lng, curr.lat, curr.lng) * 1000;
    if (distM >= 40.0 || i === valid.length - 1) {
      distinctStops.push(curr);
    }
  }

  let totalRoadKm = 0;
  const segments = [];

  for (let i = 1; i < distinctStops.length; i++) {
    const from = distinctStops[i - 1];
    const to = distinctStops[i];
    const seg = await getRoadDistance(from.lat, from.lng, to.lat, to.lng);
    totalRoadKm += seg.distanceKm;
    segments.push({
      from: { lat: from.lat, lng: from.lng, time: from.timestamp },
      to: { lat: to.lat, lng: to.lng, time: to.timestamp },
      distanceKm: seg.distanceKm,
      source: seg.source
    });
  }

  return {
    totalRoadKm: Math.round(totalRoadKm * 100) / 100,
    segments
  };
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
  getRoadDistance,
  computeRouteRoadDistance,
  haversineStraightKm
};
