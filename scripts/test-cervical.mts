import * as THREE from 'three';
// Simulate the cervical reshaping logic standalone.

// Build a synthetic "head model": a box 4x6x3, center at origin.
const geo = new THREE.BoxGeometry(4, 6, 3);
const rest = Float32Array.from(geo.attributes.position.array as ArrayLike<number>);
const pos = Float32Array.from(rest);

const vals = [0, 0, 0, 0, 0.8, 1, 2.7, 3.3, 3.5, 3.4, 2.3, 1.4, 1.4, 1.1, 0.3, 0.1, 0, 0, 0, 0, 0];
const n = vals.length;

const hAxis = 0; // X = head→shoulder
const oAxis = 1; // Y = tray axis
const trayDir = -1; // downward
const cervicalScale = 1.0;

let hMin = Infinity, hMax = -Infinity;
for (let i = 0; i < rest.length; i += 3) {
  const h = rest[i + hAxis];
  if (h < hMin) hMin = h; if (h > hMax) hMax = h;
}
const rangeH = Math.max(1e-6, hMax - hMin);

// datum: average of the extremes
let sum = 0, cnt = 0;
for (let i = 0; i < rest.length; i += 3) {
  sum += rest[i + oAxis] * trayDir; cnt++;
}
const D = sum / cnt;

let moved = 0, total = 0;
for (let i = 0; i < rest.length; i += 3) {
  pos[i] = rest[i]; pos[i + 1] = rest[i + 1]; pos[i + 2] = rest[i + 2];
  total++;
  const t = (hMax - rest[i + hAxis]) / rangeH;
  const f = Math.min(n - 1, Math.max(0, t * (n - 1)));
  const i0 = Math.floor(f);
  const frac = f - i0;
  const curveVal = vals[i0] + (vals[Math.min(n - 1, i0 + 1)] - vals[i0]) * frac;
  const natProtr = rest[i + oAxis] * trayDir - D;
  const targetProtr = -curveVal * cervicalScale;
  const finalProtr = Math.max(natProtr, targetProtr);
  const newO = (D + finalProtr) * trayDir;
  if (Math.abs(newO - rest[i + oAxis]) > 0.01) moved++;
  pos[i + oAxis] = newO;
}
console.log(`total vertices=${total}, moved=${moved}`);
if (moved > 0) {
  console.log('RESULT: reshaping works — vertices ARE moving.');
} else {
  console.log('RESULT: NO vertices moved — check axis/sign/datum.');
}
