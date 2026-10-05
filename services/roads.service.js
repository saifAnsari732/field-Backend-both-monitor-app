const fetch = require('node-fetch');

/**
 * services/roads.service.js — Google Roads API Integration
 * Snaps raw GPS coordinates to roads with interpolation for ultra-precise road geometry.
 */

const MAX_POINTS_PER_REQUEST = 100;

/**
 * Snap an array of coordinates to the nearest road network using Google Roads API.
 * @param {Array<{lat: number, lng: number}>} points - Array of GPS points
 * @param {boolean} interpolate - Whether to interpolate points along the road curves
 * @returns {Promise<Array<{lat: number, lng: number}>>} Snapped coordinates
 */
async function snapToRoads(points = [], interpolate = true) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !Array.isArray(points) || points.length < 2) {
    return points;
  }

  // Filter valid finite coordinates
  const validPoints = points.filter(
    (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
  );

  if (validPoints.length < 2) return validPoints;

  try {
    const snappedResults = [];

    // Process in batches of up to 100 points (Google Roads API limitation)
    for (let i = 0; i < validPoints.length; i += MAX_POINTS_PER_REQUEST - 1) {
      const batch = validPoints.slice(i, i + MAX_POINTS_PER_REQUEST);
      if (batch.length < 2) {
        if (batch.length === 1 && snappedResults.length === 0) {
          snappedResults.push(batch[0]);
        }
        continue;
      }

      const pathStr = batch.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`).join('|');
      const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(pathStr)}&interpolate=${interpolate}&key=${apiKey}`;

      const response = await fetch(url, { timeout: 8000 });
      const data = await response.json();

      if (data && Array.isArray(data.snappedPoints) && data.snappedPoints.length > 0) {
        data.snappedPoints.forEach((sp) => {
          if (sp.location?.latitude && sp.location?.longitude) {
            snappedResults.push({
              lat: sp.location.latitude,
              lng: sp.location.longitude,
              originalIndex: typeof sp.originalIndex === 'number' ? i + sp.originalIndex : null,
              placeId: sp.placeId || null,
              snapped: true
            });
          }
        });
      } else {
        // If Roads API didn't snap this batch (e.g. off-road / alleyway), retain original points
        batch.forEach((p) => snappedResults.push(p));
      }
    }

    return snappedResults.length > 0 ? snappedResults : validPoints;
  } catch (err) {
    console.warn('⚠️ [ROADS_API] snapToRoads fallback to raw points:', err.message);
    return validPoints;
  }
}

module.exports = { snapToRoads };
