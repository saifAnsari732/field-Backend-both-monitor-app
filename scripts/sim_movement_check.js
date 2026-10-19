const fs = require('fs');
const src = fs.readFileSync('../CRM-App-front/services/locationTask.js', 'utf8');
const start = src.indexOf('let _movementCandidateBuffer');
const end = src.indexOf('// Heartbeat manager');
const body = src.slice(start, end).replace(/\bexport\b/g, '');
const R = 6371000;
const hav = (a, b, c, d) => {
  const r = Math.PI / 180, dl = (c - a) * r, dg = (d - b) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)) / 1000;
};
const code = 'const haversineKm=hav;const MAX_SPEED_KMH=180;' + body +
  ';return {validateSegment,evaluateMovementTransition,reset(){_isConfirmedMoving=false;_movementCandidateBuffer=[]}};';
const m = new Function('hav', code)(hav);

function run(name, pts) {
  m.reset();
  let anchor = null, total = 0;
  for (const p of pts) {
    if (!anchor) { anchor = { lat: p.lat, lng: p.lng, timestamp: new Date(p.t).toISOString(), lastTickTimestamp: new Date(p.t).toISOString() }; continue; }
    const cur = { lat: p.lat, lng: p.lng, speed: p.sp, accuracy: p.acc, timestamp: new Date(p.t).toISOString() };
    const r = m.validateSegment(anchor, cur);
    let valid = r.valid, dist = r.distKm;
    if (r.keepMovingAnchor) continue;
    if (!valid && !r.reanchorOnly && !r.isOutlier) {
      const dM = hav(anchor.lat, anchor.lng, p.lat, p.lng) * 1000;
      const secs = Math.min(Math.max((p.t - new Date(anchor.lastTickTimestamp).getTime()) / 1000, 1), 20);
      const tr = m.evaluateMovementTransition(p.lat, p.lng, dM, secs, p.sp, dM / 1000 / secs * 3600, p.acc, null);
      if (tr.confirmed) { valid = true; dist = tr.backfillDistKm; }
    }
    if (valid) { total += dist; anchor = { lat: p.lat, lng: p.lng, timestamp: cur.timestamp, lastTickTimestamp: cur.timestamp }; }
    else anchor.lastTickTimestamp = cur.timestamp;
  }
  console.log(name, '=> counted', total.toFixed(3), 'km');
}

const lng = 80.95;
function straight(km, kmh, sp, acc) {
  const pts = []; let t = 0, la = 26.85;
  const stepDeg = (kmh / 3.6 * 4) / 111000;
  const n = Math.round(km * 1000 / (kmh / 3.6 * 4));
  for (let i = 0; i <= n; i++) { t += 4000; pts.push({ lat: la, lng, sp, acc, t }); la += stepDeg; }
  return pts;
}
let pts = [], t = 0;
for (let i = 0; i < 900; i++) {
  t += 4000;
  const j = () => (Math.random() - 0.5) * 2 * 20 / 111000;
  pts.push({ lat: 26.85 + j(), lng: lng + j(), sp: 0, acc: 20, t });
}
run('Stationary 1h jitter +-20m (0 expected)   ', pts);
run('Ride 5km @30kmh (~5 expected)             ', straight(5, 30, 30 / 3.6, 10));
run('Walk 1km @5kmh (~1 expected)              ', straight(1, 5, 5 / 3.6, 10));
run('Ride 5km, Doppler=0 pocket (~5 expected)  ', straight(5, 30, 0, 15));
run('Walk 1km, Doppler=0 pocket (~1 expected)  ', straight(1, 5, 0, 15));
