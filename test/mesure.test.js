const assert = require('assert');
const M = require('../src/mesure.js'), B = require('../src/battements.js');
const sr = 16000;
function note(f0, Bi, dur, det) {
  const n = dur * sr, x = new Float32Array(n);
  for (let h = 1; h <= 12; h++) {
    const f = B.partiel(f0, h, Bi), a = Math.pow(h, -0.6) * Math.abs(Math.sin(Math.PI * h / 8.3)), tau = 4 / (1 + 0.35 * (h - 1));
    for (const d of (det ? [0, det] : [0])) for (let i = 0; i < n; i++) x[i] += a * Math.exp(-i / sr / tau) * Math.sin(2 * Math.PI * (f + d) * i / sr);
  }
  return x;
}
const iv = B.INTERVALLES.find(i => i.k === 4), Bi = 3e-4, th = B.battement(57, iv, 440, Bi, 0);
const fc = (B.partiel(B.freq(57, 440), 5, Bi) + B.partiel(B.freq(61, 440), 4, Bi)) / 2;
const mix = (a, b) => a.map((v, i) => v + b[i]);
let r = M.analyser(mix(note(B.freq(57, 440), Bi, 2), note(B.freq(61, 440), Bi, 2)), sr, fc, 10, 0.3, 25);
assert(Math.abs(r.pics[0].hz - th) < 0.1, 'battement propre ' + r.pics[0].hz);
r = M.analyser(mix(note(B.freq(57, 440), Bi, 4, 3), note(B.freq(61, 440), Bi, 4)), sr, fc, 10, 0.3, 25);
assert(r.pics.some(p => Math.abs(p.hz - th) < 0.15) && r.pics.some(p => Math.abs(p.hz - 3) < 0.15), 'fausse corde : les deux battements sont vus');
console.log('Mesure : OK');
