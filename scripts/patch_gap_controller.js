const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../controllers/tracking.controller.js');
let content = fs.readFileSync(file, 'utf8');

const target = '.log(`📍 [STATIONARY_WAKEUP] Accepted +${effectiveGapKm.toFixed(4)} km after ${(dt / 60).toFixed(0)} min stationary gap (speed: ${effectiveResumeSpeed.toFixed(1)} km/h)`);\r\n        }';

const replacement = `.log(\`📍 [STATIONARY_WAKEUP] Accepted +\${effectiveGapKm.toFixed(4)} km after \${(dt / 60).toFixed(0)} min stationary gap (speed: \${effectiveResumeSpeed.toFixed(1)} km/h)\`);
        } else if (dGapKm >= 0.080) {
          // Long gap or overnight jump (>2.5h or >65km or unrealistic speed): Re-anchor to new position WITHOUT adding unverified distance
          const safeFromEventId = lastEventId || (prevValid?.timestamp ? \`\${sessionId}:\${new Date(prevValid.timestamp).getTime()}\` : \`\${sessionId}:start\`);
          ledgerSegments.push({
            organizationId: orgId,
            employee: req.user._id,
            sessionId,
            fromEventId: safeFromEventId,
            toEventId: eventId,
            fromTimestamp: new Date(lastTrustedMs),
            toTimestamp: timestamp,
            fromLat: prevValid?.latRaw ?? lastValidLat,
            fromLng: prevValid?.lngRaw ?? lastValidLng,
            toLat: lat,
            toLng: lng,
            distanceMeters: Math.round(dGapKm * 1000),
            distanceKm: Number(dGapKm.toFixed(4)),
            classification: 'UNVERIFIED',
            reason: dt > 150 * 60 ? 'AGTRIE_X_LONG_GAP_OVERNIGHT_EXCEEDED_150MIN' : (dGapKm > 65.0 ? 'AGTRIE_X_LONG_GAP_EXCEEDED_65KM' : 'AGTRIE_X_UNVERIFIED_GAP_SPEED'),
            algorithmVersion: 'AGTRIE-X-v15.0-PURE-GPS'
          });

          console.log(\`📍 [LONG_GAP_REANCHOR] Re-anchored to new position (\${dGapKm.toFixed(1)} km gap after \${(dt / 60).toFixed(0)} min). Distance NOT added (unverified).\`);
        }`.replace(/\n/g, '\r\n');

if (!content.includes(target)) {
  console.error('Target string not found in tracking.controller.js!');
  process.exit(1);
}

content = content.replace(target, replacement);
fs.writeFileSync(file, content, 'utf8');
console.log('Successfully patched tracking.controller.js with long gap re-anchor logic!');
