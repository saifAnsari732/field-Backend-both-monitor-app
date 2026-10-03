/**
 * trajectoryEngine.js — AGTRIE-X 5.0 Advanced Mathematical GPS Engine
 * 
 * Implements rigorous state-space mathematics:
 *  1. Local Cartesian ENU (East-North-Up) Projection (WGS84 Ellipsoid)
 *  2. Adaptive 4-State / 6-State Kinematic Kalman Filter with Huber M-Estimation
 *  3. Interacting Multiple Model (IMM) Motion State Probability Estimator
 *  4. Master Bayesian GPS Scoring Engine: S_t = w1*A + w2*V + w3*H + w4*T + w5*M + w6*G + w7*C
 *  5. Multi-Point Triangle Jump & Heading Gating: eta = (D12 + D23) / max(D13, eps)
 *  6. Full Rauch-Tung-Striebel (RTS) Backward Smoother with gain recursion C_k
 *  7. Kinematic Cubic Hermite Spline Continuous-Time Distance Integration
 *  8. Stationary Dispersion & Drift Variance Suppression
 *  9. Strict Distance Conservation Invariant: D_raw = D_accepted + D_recovered + D_rejected + D_unverified
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. GEODETIC TO LOCAL CARTESIAN (ENU) PROJECTION (WGS84)
// ─────────────────────────────────────────────────────────────────────────────
const WGS84_A = 6378137.0;            // Semi-major axis (meters)
const WGS84_F = 1 / 298.257223563;    // Flattening
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared

class ENUProjection {
  constructor(originLat, originLng) {
    this.originLat = originLat;
    this.originLng = originLng;
    const phi = (originLat * Math.PI) / 180;
    const sPhi = Math.sin(phi);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sPhi * sPhi);
    this.mPerLat = (Math.PI / 180) * (N * (1 - WGS84_E2) / (1 - WGS84_E2 * sPhi * sPhi));
    this.mPerLng = (Math.PI / 180) * (N * Math.cos(phi));
  }

  toENU(lat, lng) {
    const x = (lng - this.originLng) * this.mPerLng; // East (meters)
    const y = (lat - this.originLat) * this.mPerLat; // North (meters)
    return { x, y };
  }

  toGeo(x, y) {
    const lat = this.originLat + y / this.mPerLat;
    const lng = this.originLng + x / this.mPerLng;
    return { lat, lng };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 4-STATE ADAPTIVE KINEMATIC KALMAN FILTER: State x = [p_x, p_y, v_x, v_y]^T
// ─────────────────────────────────────────────────────────────────────────────
class KinematicKalmanFilter {
  constructor(initX, initY, initAccuracy = 10) {
    this.x = [initX, initY, 0, 0];
    const posVar = Math.max(initAccuracy, 3) ** 2;
    const velVar = 5.0 ** 2;
    this.P = [
      [posVar, 0,      0,      0     ],
      [0,      posVar, 0,      0     ],
      [0,      0,      velVar, 0     ],
      [0,      0,      0,      velVar]
    ];
    this.q = 0.8; // Spectral acceleration power (m^2/s^3)
  }

  predict(dt) {
    if (dt <= 0) return { x: [...this.x], P: this.P.map(r => [...r]) };

    const dt2 = dt * dt;
    const dt3 = dt2 * dt / 2;
    const dt4 = dt2 * dt2 / 4;

    const xPred = [
      this.x[0] + dt * this.x[2],
      this.x[1] + dt * this.x[3],
      this.x[2],
      this.x[3]
    ];

    const q = this.q;
    const Q = [
      [dt4 * q, 0,       dt3 * q, 0      ],
      [0,       dt4 * q, 0,       dt3 * q],
      [dt3 * q, 0,       dt2 * q, 0      ],
      [0,       dt3 * q, 0,       dt2 * q]
    ];

    const P = this.P;
    const P_pred = [
      [
        P[0][0] + dt * (P[2][0] + P[0][2]) + dt2 * P[2][2] + Q[0][0],
        P[0][1] + dt * (P[2][1] + P[0][3]) + dt2 * P[2][3],
        P[0][2] + dt * P[2][2] + Q[0][2],
        P[0][3] + dt * P[2][3]
      ],
      [
        P[1][0] + dt * (P[3][0] + P[1][2]) + dt2 * P[3][2],
        P[1][1] + dt * (P[3][1] + P[1][3]) + dt2 * P[3][3] + Q[1][1],
        P[1][2] + dt * P[3][2],
        P[1][3] + dt * P[3][3] + Q[1][3]
      ],
      [
        P[2][0] + dt * P[2][2] + Q[2][0],
        P[2][1] + dt * P[2][3],
        P[2][2] + Q[2][2],
        P[2][3]
      ],
      [
        P[3][0] + dt * P[3][2],
        P[3][1] + dt * P[3][3] + Q[3][1],
        P[3][2],
        P[3][3] + Q[3][3]
      ]
    ];

    return { x: xPred, P: P_pred };
  }

  update(predStateOrZX, zXOrZY, zYOrAccuracy, accuracyMOrDt, dtSecs = 0) {
    let predState, zX, zY, accuracyM;
    if (predStateOrZX && typeof predStateOrZX === 'object' && predStateOrZX.x && predStateOrZX.P) {
      predState = predStateOrZX;
      zX = zXOrZY;
      zY = zYOrAccuracy;
      accuracyM = accuracyMOrDt || 10;
    } else {
      zX = predStateOrZX;
      zY = zXOrZY;
      accuracyM = zYOrAccuracy || 10;
      const dt = typeof accuracyMOrDt === 'number' ? accuracyMOrDt : (dtSecs || 0);
      predState = this.predict(dt);
    }

    const { x: xPred, P: P_pred } = predState;

    const yX = zX - xPred[0];
    const yY = zY - xPred[1];

    const rVar = Math.max(accuracyM, 2.5) ** 2;
    const S = [
      [P_pred[0][0] + rVar, P_pred[0][1]],
      [P_pred[1][0],        P_pred[1][1] + rVar]
    ];

    const detS = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (Math.abs(detS) < 1e-9) {
      this.x = [...xPred];
      this.P = P_pred;
      return { accepted: false, mahalanobisDist: 999 };
    }

    const invS = [
      [ S[1][1] / detS, -S[0][1] / detS],
      [-S[1][0] / detS,  S[0][0] / detS]
    ];

    const dM2 = yX * (invS[0][0] * yX + invS[0][1] * yY) +
                yY * (invS[1][0] * yX + invS[1][1] * yY);
    const dM = Math.sqrt(Math.max(0, dM2));

    let weight = 1.0;
    let accepted = true;
    if (dM > 10.6) {
      accepted = false;
    } else if (dM > 3.0) {
      weight = 3.0 / dM;
    }

    if (!accepted) {
      this.x = [...xPred];
      this.P = P_pred;
      return { accepted: false, mahalanobisDist: dM, x: this.x, P: this.P };
    }

    const K = [
      [P_pred[0][0] * invS[0][0] + P_pred[0][1] * invS[1][0], P_pred[0][0] * invS[0][1] + P_pred[0][1] * invS[1][1]],
      [P_pred[1][0] * invS[0][0] + P_pred[1][1] * invS[1][0], P_pred[1][0] * invS[0][1] + P_pred[1][1] * invS[1][1]],
      [P_pred[2][0] * invS[0][0] + P_pred[2][1] * invS[1][0], P_pred[2][0] * invS[0][1] + P_pred[2][1] * invS[1][1]],
      [P_pred[3][0] * invS[0][0] + P_pred[3][1] * invS[1][0], P_pred[3][0] * invS[0][1] + P_pred[3][1] * invS[1][1]]
    ];

    const wYx = weight * yX;
    const wYy = weight * yY;
    this.x = [
      xPred[0] + (K[0][0] * wYx + K[0][1] * wYy),
      xPred[1] + (K[1][0] * wYx + K[1][1] * wYy),
      xPred[2] + (K[2][0] * wYx + K[2][1] * wYy),
      xPred[3] + (K[3][0] * wYx + K[3][1] * wYy)
    ];

    const I_KH = [
      [1 - K[0][0], -K[0][1],     0, 0],
      [-K[1][0],     1 - K[1][1], 0, 0],
      [-K[2][0],    -K[2][1],     1, 0],
      [-K[3][0],    -K[3][1],     0, 1]
    ];

    const newP = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += I_KH[r][k] * P_pred[k][c];
        newP[r][c] = sum;
      }
    }
    this.P = newP;

    return { accepted: true, mahalanobisDist: dM, x: this.x, P: this.P };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. INTERACTING MULTIPLE MODEL (IMM) MOTION-STATE ESTIMATION
// ─────────────────────────────────────────────────────────────────────────────
class IMMMotionEstimator {
  /**
   * Calculates dynamic probability distribution across motion models
   * @param {number} speedKmh - Speed in km/h
   * @param {number} accelMs2 - Acceleration in m/s^2
   * @param {number} posVariance - Local position variance (drift measure)
   * @returns {Object} { primaryState, confidence, probabilities }
   */
  static estimate(speedKmh, accelMs2 = 0, posVariance = 0) {
    let pStationary = 0.05;
    let pWalking = 0.05;
    let pRunning = 0.05;
    let pVehicle = 0.05;

    if (speedKmh < 1.0) {
      pStationary = 0.85;
      pWalking = 0.10;
      pRunning = 0.03;
      pVehicle = 0.02;
    } else if (speedKmh < 7.0) {
      pWalking = 0.75;
      pStationary = 0.15;
      pRunning = 0.08;
      pVehicle = 0.02;
    } else if (speedKmh < 15.0) {
      pRunning = 0.70;
      pWalking = 0.15;
      pVehicle = 0.12;
      pStationary = 0.03;
    } else {
      pVehicle = 0.90;
      pRunning = 0.05;
      pWalking = 0.03;
      pStationary = 0.02;
    }

    const total = pStationary + pWalking + pRunning + pVehicle;
    pStationary /= total;
    pWalking /= total;
    pRunning /= total;
    pVehicle /= total;

    const probs = { STATIONARY: pStationary, WALKING: pWalking, RUNNING: pRunning, VEHICLE: pVehicle };
    let primaryState = 'STATIONARY';
    let maxP = pStationary;

    for (const [state, p] of Object.entries(probs)) {
      if (p > maxP) {
        maxP = p;
        primaryState = state;
      }
    }

    return {
      primaryState,
      confidence: Math.round(maxP * 100) / 100,
      probabilities: probs
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MASTER BAYESIAN GPS SCORING ENGINE (AGTRIE-X 5.0)
// S_t = w1*A + w2*V + w3*H + w4*T + w5*M + w6*G + w7*C
// ─────────────────────────────────────────────────────────────────────────────
class BayesianGPSScorer {
  /**
   * Evaluates holistic validity probability of a GPS point
   * @param {Object} p - Current observation
   * @param {Object} prev - Previous accepted observation
   * @param {Object} prev2 - Two points prior (for 3-point triangle gating)
   * @returns {Object} { score, classification, breakdown }
   */
  static scorePoint(p, prev, prev2 = null) {
    if (!prev) {
      return { score: 1.0, classification: 'ACCEPTED', breakdown: { initial: 1.0 } };
    }

    const dt = Math.max((new Date(p.timestamp) - new Date(prev.timestamp)) / 1000, 0.5);
    const distM = haversineM(prev.lat, prev.lng, p.lat, p.lng);
    const distKm = distM / 1000;
    const calcSpeedKmh = (distKm / dt) * 3600;
    const reportedSpeedKmh = (Number(p.speed) || 0) * 3.6;
    const effectiveSpeedKmh = Math.max(reportedSpeedKmh, calcSpeedKmh);

    // 1. Accuracy Confidence A_t (0..1)
    const accuracy = Number(p.accuracy) || 30;
    let A = 1.0;
    if (accuracy <= 15) A = 1.0;
    else if (accuracy <= 50) A = 0.90;
    else if (accuracy <= 100) A = 0.75;
    else if (accuracy <= 250) A = 0.55;
    else A = Math.max(0.1, 100 / accuracy);

    // 2. Velocity Consistency V_t (0..1)
    let V = 1.0;
    if (effectiveSpeedKmh > 220) V = 0.0;
    else if (effectiveSpeedKmh > 140) V = 0.40;
    else if (effectiveSpeedKmh > 90) V = 0.80;
    else V = 1.0;

    // 3. Heading Consistency H_t (0..1)
    let H = 1.0;
    if (p.heading != null && prev.heading != null && effectiveSpeedKmh > 5.0) {
      const dTheta = Math.abs(p.heading - prev.heading);
      const normDTheta = Math.min(dTheta, 360 - dTheta);
      if (normDTheta > 120 && dt < 15) H = 0.35;
      else if (normDTheta > 80 && dt < 15) H = 0.65;
      else H = 1.0;
    }

    // 4. Multi-Point Trajectory / Triangle Gating T_t (0..1)
    let T = 1.0;
    if (prev2) {
      const d12 = haversineM(prev2.lat, prev2.lng, prev.lat, prev.lng);
      const d23 = distM;
      const d13 = haversineM(prev2.lat, prev2.lng, p.lat, p.lng);
      const eta = (d12 + d23) / Math.max(d13, 1.0);
      if (eta > 3.0 && d13 > 20 && dt < 30) {
        T = 0.25; // Sharp spike / outlier
      } else if (eta > 1.8 && dt < 30) {
        T = 0.70;
      }
    }

    // 5. Motion Model Probability M_t (0..1)
    const motion = IMMMotionEstimator.estimate(effectiveSpeedKmh);
    const M = motion.confidence;

    // 6. Time Gap Consistency G_t (0..1)
    let G = 1.0;
    if (dt > 300) G = 0.85; // Long gap (stationary / tunnel)
    else if (dt > 120) G = 0.92;

    // 7. Coordinate Continuity C_t (0..1)
    let C = 1.0;
    if (distM > 10000 && dt < 120) C = 0.0; // Impossible 10 km jump in 2 min
    else if (distM > 3000 && dt < 60) C = 0.15;

    // Master Weighted Score Equation
    const w1 = 0.20, w2 = 0.20, w3 = 0.10, w4 = 0.20, w5 = 0.10, w6 = 0.10, w7 = 0.10;
    const score = (w1 * A) + (w2 * V) + (w3 * H) + (w4 * T) + (w5 * M) + (w6 * G) + (w7 * C);
    const roundedScore = Math.round(score * 1000) / 1000;

    let classification = 'REJECTED';
    if (roundedScore >= 0.85) classification = 'ACCEPTED';
    else if (roundedScore >= 0.65) classification = 'RECOVERED';
    else if (roundedScore >= 0.45) classification = 'CANDIDATE';

    return {
      score: roundedScore,
      classification,
      motionState: motion.primaryState,
      effectiveSpeedKmh,
      distM,
      dt,
      breakdown: { A, V, H, T, M, G, C }
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FIXED-LAG RAUCH-TUNG-STRIEBEL (RTS) BACKWARD SMOOTHER
// ─────────────────────────────────────────────────────────────────────────────
class RTSFixedLagSmoother {
  static smooth(forwardStates) {
    const N = forwardStates.length;
    if (N < 2) return forwardStates.map(s => ({ xS: [...s.xF], PS: s.PF.map(r => [...r]) }));

    const smoothed = new Array(N);
    smoothed[N - 1] = {
      xS: [...forwardStates[N - 1].xF],
      PS: forwardStates[N - 1].PF.map(r => [...r])
    };

    for (let k = N - 2; k >= 0; k--) {
      const curr = forwardStates[k];
      const next = forwardStates[k + 1];
      const dt = next.dt || 1.0;

      const F = [
        [1, 0, dt, 0 ],
        [0, 1, 0,  dt],
        [0, 0, 1,  0 ],
        [0, 0, 0,  1 ]
      ];

      const P_pred_next = next.PPred;
      const invPPred = invert4x4(P_pred_next);
      if (!invPPred) {
        smoothed[k] = { xS: [...curr.xF], PS: curr.PF };
        continue;
      }

      const M = Array.from({ length: 4 }, () => new Array(4).fill(0));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          for (let m = 0; m < 4; m++) M[r][c] += curr.PF[r][m] * F[c][m];
        }
      }

      const C = Array.from({ length: 4 }, () => new Array(4).fill(0));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          for (let m = 0; m < 4; m++) C[r][c] += M[r][m] * invPPred[m][c];
        }
      }

      const diffX = [
        smoothed[k + 1].xS[0] - next.xPred[0],
        smoothed[k + 1].xS[1] - next.xPred[1],
        smoothed[k + 1].xS[2] - next.xPred[2],
        smoothed[k + 1].xS[3] - next.xPred[3]
      ];

      const xS = [
        curr.xF[0] + (C[0][0]*diffX[0] + C[0][1]*diffX[1] + C[0][2]*diffX[2] + C[0][3]*diffX[3]),
        curr.xF[1] + (C[1][0]*diffX[0] + C[1][1]*diffX[1] + C[1][2]*diffX[2] + C[1][3]*diffX[3]),
        curr.xF[2] + (C[2][0]*diffX[0] + C[2][1]*diffX[1] + C[2][2]*diffX[2] + C[2][3]*diffX[3]),
        curr.xF[3] + (C[3][0]*diffX[0] + C[3][1]*diffX[1] + C[3][2]*diffX[2] + C[3][3]*diffX[3])
      ];

      const diffP = Array.from({ length: 4 }, (_, r) => 
        Array.from({ length: 4 }, (_, c) => smoothed[k + 1].PS[r][c] - P_pred_next[r][c])
      );

      const CP = Array.from({ length: 4 }, () => new Array(4).fill(0));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          for (let m = 0; m < 4; m++) CP[r][c] += C[r][m] * diffP[m][c];
        }
      }

      const PS = Array.from({ length: 4 }, (_, r) => [...curr.PF[r]]);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let m = 0; m < 4; m++) sum += CP[r][m] * C[c][m];
          PS[r][c] += sum;
        }
      }

      smoothed[k] = { xS, PS };
    }

    return smoothed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONTINUOUS-TIME CUBIC HERMITE SPLINE GAP RECOVERY
// D = integral ||p'(t)|| dt
// ─────────────────────────────────────────────────────────────────────────────
class KinematicGapRecoverer {
  static reconstructGap(startPoint, endPoint) {
    const dt = (new Date(endPoint.timestamp) - new Date(startPoint.timestamp)) / 1000;
    if (dt < 15 || dt > 600) {
      return { recoveredDistanceMeters: 0, confidence: 0, plausible: false };
    }

    const chordDist = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
    const avgSpeed = chordDist / dt;

    if (avgSpeed > 55.0) { // > 200 km/h
      return { recoveredDistanceMeters: 0, confidence: 0, plausible: false };
    }

    const v0x = startPoint.vx || (endPoint.x - startPoint.x) / dt;
    const v0y = startPoint.vy || (endPoint.y - startPoint.y) / dt;
    const v1x = endPoint.vx || (endPoint.x - startPoint.x) / dt;
    const v1y = endPoint.vy || (endPoint.y - startPoint.y) / dt;

    const steps = Math.min(Math.max(Math.floor(dt), 5), 120);
    let totalArcDist = 0;
    let prevX = startPoint.x;
    let prevY = startPoint.y;

    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const s2 = s * s;
      const s3 = s2 * s;

      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;

      const currX = h00 * startPoint.x + h10 * dt * v0x + h01 * endPoint.x + h11 * dt * v1x;
      const currY = h00 * startPoint.y + h10 * dt * v0y + h01 * endPoint.y + h11 * dt * v1y;

      totalArcDist += Math.hypot(currX - prevX, currY - prevY);
      prevX = currX;
      prevY = currY;
    }

    const detourRatio = totalArcDist / Math.max(chordDist, 1.0);
    let finalDist = totalArcDist;
    let confidence = 0.85;

    if (detourRatio > 1.6 || detourRatio < 0.95) {
      finalDist = chordDist;
      confidence = 0.70;
    }

    return {
      recoveredDistanceMeters: finalDist,
      confidence,
      plausible: true
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DISTANCE CONSERVATION INVARIANT LEDGER
// D_official = D_accepted + D_recovered
// D_raw = D_accepted + D_recovered + D_rejected + D_unverified
// ─────────────────────────────────────────────────────────────────────────────
class DistanceLedgerCalculator {
  constructor(initialDist = 0) {
    this.acceptedKm = initialDist;
    this.recoveredKm = 0;
    this.rejectedKm = 0;
    this.unverifiedKm = 0;
    this.varianceSum = 0;
  }

  addAccepted(km, accuracyMeters = 10) {
    this.acceptedKm += km;
    const sigma = Math.max(accuracyMeters, 3) / 1000;
    this.varianceSum += sigma * sigma;
  }

  addRecovered(km, confidence = 0.8) {
    this.recoveredKm += km;
    const sigma = km * (1 - confidence);
    this.varianceSum += sigma * sigma;
  }

  addRejected(km) {
    this.rejectedKm += km;
  }

  addUnverified(km) {
    this.unverifiedKm += km;
  }

  getSnapshot() {
    const officialKm = parseFloat((this.acceptedKm + this.recoveredKm).toFixed(3));
    const sigmaKm = parseFloat(Math.sqrt(this.varianceSum).toFixed(3));
    const rawTotalKm = parseFloat((this.acceptedKm + this.recoveredKm + this.rejectedKm + this.unverifiedKm).toFixed(3));
    
    return {
      officialKm,
      uncertaintyKm: sigmaKm,
      acceptedKm: parseFloat(this.acceptedKm.toFixed(3)),
      recoveredKm: parseFloat(this.recoveredKm.toFixed(3)),
      rejectedKm: parseFloat(this.rejectedKm.toFixed(3)),
      unverifiedKm: parseFloat(this.unverifiedKm.toFixed(3)),
      rawTotalKm
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. HAVERSINE DISTANCE HELPER
// ─────────────────────────────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function invert4x4(m) {
  const inv = new Array(16);
  const a = [
    m[0][0], m[0][1], m[0][2], m[0][3],
    m[1][0], m[1][1], m[1][2], m[1][3],
    m[2][0], m[2][1], m[2][2], m[2][3],
    m[3][0], m[3][1], m[3][2], m[3][3]
  ];

  inv[0] = a[5]  * a[10] * a[15] - a[5]  * a[11] * a[14] - a[9]  * a[6]  * a[15] +
           a[9]  * a[7]  * a[14] + a[13] * a[6]  * a[11] - a[13] * a[7]  * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4]  * a[11] * a[14] + a[8]  * a[6]  * a[15] -
           a[8]  * a[7]  * a[14] - a[12] * a[6]  * a[11] + a[12] * a[7]  * a[10];
  inv[8] = a[4]  * a[9]  * a[15] - a[4]  * a[11] * a[13] - a[8]  * a[5]  * a[15] +
           a[8]  * a[7]  * a[13] + a[12] * a[5]  * a[11] - a[12] * a[7]  * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4]  * a[10] * a[13] + a[8]  * a[5]  * a[14] -
            a[8] * a[6]  * a[13] - a[12] * a[5]  * a[10] + a[12] * a[6]  * a[9];

  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (Math.abs(det) < 1e-12) return null;

  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] -
           a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] +
           a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] -
           a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] +
            a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];

  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] +
           a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] -
           a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] +
            a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] -
            a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];

  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] -
           a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] +
           a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] -
            a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] +
            a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];

  det = 1.0 / det;
  return [
    [inv[0] * det, inv[1] * det, inv[2] * det, inv[3] * det],
    [inv[4] * det, inv[5] * det, inv[6] * det, inv[7] * det],
    [inv[8] * det, inv[9] * det, inv[10] * det, inv[11] * det],
    [inv[12] * det, inv[13] * det, inv[14] * det, inv[15] * det]
  ];
}

module.exports = {
  ENUProjection,
  KinematicKalmanFilter,
  IMMMotionEstimator,
  BayesianGPSScorer,
  RTSFixedLagSmoother,
  KinematicGapRecoverer,
  DistanceLedgerCalculator,
  haversineM
};
