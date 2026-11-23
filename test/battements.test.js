const assert = require('assert');
const B = require('../src/battements.js');

const iv = k => B.INTERVALLES.find(i => i.k === k);
const calc = (midi, k, Bi) => B.calc(midi, iv(k), 440, Bi || 0);
const proche = (a, b, tol, nom) => { assert(Math.abs(a - b) <= tol, `${nom} : ${a} != ${b}`); console.log('OK', nom, a.toFixed(3)); };

// La3 = MIDI 57 (220 Hz)
proche(calc(57, 4).hz, 8.73, 0.02, 'Tierce majeure La3-Do#4 (8,73 Hz)');
proche(calc(57, 7).hz, 0.745, 0.01, 'Quinte La3-Mi4 (0,74 Hz)');
proche(calc(57, 5).hz, 0.994, 0.01, 'Quarte La3-Ré4 (0,99 Hz)');
proche(calc(57, 9).hz, 9.98, 0.02, 'Sixte majeure La3-Fa#4 (9,98 Hz)');
proche(calc(57, 12).hz, 0, 1e-9, 'Octave pure = 0 battement');

assert.strictEqual(calc(57, 4).sens, 'large');
assert.strictEqual(calc(57, 7).sens, 'étroit');
assert(calc(57, 12, 0.0004).hz > 0.1, 'inharmonicité : octave doit battre');
assert.strictEqual(B.nomNote(57), 'La3');
assert.strictEqual(B.nomNote(61), 'Do♯4');
assert(Math.abs(B.freq(69, 442) - 442) < 1e-9);

// Une tierce majeure bat plus vite quand on monte (2x par octave)
const r1 = calc(53, 4).hz, r2 = calc(65, 4).hz;
proche(r2 / r1, 2, 0.001, 'Tierce : battement x2 par octave');

// Contrôle d'octave : tierce mineure du bas = sixte majeure du haut quand l'octave 6:3 est pure
for (const bb of [0, 2e-4, 6e-4]) {
  for (const X of [41, 47, 53]) {
    const dc = B.octaveEgale(X, 440, bb);
    const m3 = B.battement(X, iv(3), 440, bb, 0);
    const m6 = B.battement(X + 3, iv(9), 440, bb, dc);
    proche(m6, m3, 1e-6, `octave ${B.nomNote(X)} B=${bb} : m3 = M6 (${m3.toFixed(3)} Hz, octave ${dc.toFixed(2)} ct)`);
  }
}
proche(B.octaveEgale(53, 440, 0), 0, 1e-9, 'B=0 : octave tempérée = octave 6:3 pure');
proche(B.battement(57, iv(4), 440, 0, 0), 8.731, 0.01, 'battement() sans décalage = calc()');

console.log('\nTous les tests passent.');
