import { describe, expect, it } from 'vitest';
import { AudioProcessor } from '../audioProcessor';
import { NoteTracker } from '../noteTracker';
import { midiToFreq } from '..';
import { SR, synthNote, whiteNoise, add } from './synth';
import { planFor, centsFromPlan, partial, octaveRank, type Tuned } from '../../tuning/reference';

/** Joue une note synthétique et renvoie l'écart moyen (cents) au plan, calculé comme dans l'appli, sur les fenêtres stables. */
function readCents(midi: number, f0: number, B: number, tuned: Tuned, k1Gain = 1): number {
  const proc = new AudioProcessor({ sampleRate: SR }); const t = new NoteTracker(); proc.setTracker(t); t.setCurrent(midi);
  const sig = add(whiteNoise(2.2, 3e-4, 9), synthNote({ f0, B, dur: 1.8, kMin: midi < 33 ? 2 : 1, k1Gain }, 4), 0);
  const vals: number[] = [];
  proc.push(whiteNoise(0.8, 3e-4, 5));
  for (let i = 0; i < sig.length; i += 2048) for (const e of proc.push(sig.subarray(i, i + 2048))) {
    if (!e.frame) continue;
    const plan = planFor(e.frame.note.midi, tuned, 'mixte');
    const c = centsFromPlan(plan, e.frame.note.midi, tuned, e.frame.fit.f0, e.fused?.B ?? e.frame.fit.B, e.frame.fit.partials);
    if (c != null) vals.push(c);
  }
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}
/** f0 de la note grave qui rend l'octave pure au rang j (partielle 2j de lo = partielle j de hi). */
const pureLow = (hi: { f0: number; B: number }, Blo: number, j: number) => partial(hi, j) / (2 * j * Math.sqrt(1 + Blo * 4 * j * j));
const pureHigh = (lo: { f0: number; B: number }, Bhi: number, j: number) => partial(lo, 2 * j) / (j * Math.sqrt(1 + Bhi * j * j));

describe('accord sur les notes déjà accordées', () => {
  it('plans : octave du dessus vers les graves, du dessous vers les aigus, partition entre deux La, sinon courbe', () => {
    const tuned: Tuned = { 57: { f0: 220, B: 8e-4 }, 69: { f0: 440, B: 1e-3 } };
    expect(planFor(45, tuned, 'mixte')).toEqual({ kind: 'octave', ref: 57, j: 3, below: true });
    expect(planFor(81, tuned, 'mixte')).toEqual({ kind: 'octave', ref: 69, j: 2, below: false });
    expect(planFor(62, tuned, 'mixte')).toEqual({ kind: 'partition', lo: 57, hi: 69 });
    expect(planFor(30, tuned, 'mixte')).toEqual({ kind: 'courbe' });
    expect(octaveRank(33, 'mixte')).toBe(3);
  });

  it('octave 4:2 La3 sur La4 accordé à +0,4 ct : lu 0 quand l’octave est pure, ±5 ct quand on s’en écarte de 5 ct', () => {
    const A4 = { f0: 440 * 2 ** (0.4 / 1200), B: 1.0e-3 }, BA3 = 7e-4;
    const tuned: Tuned = { 69: A4 };
    const f = pureLow(A4, BA3, 2);
    expect(Math.abs(readCents(57, f, BA3, tuned))).toBeLessThan(0.3);
    expect(readCents(57, f * 2 ** (5 / 1200), BA3, tuned)).toBeCloseTo(5, 0);
  });

  it('basses en 6:3 : La1 sur La2, fondamentale très faible, gros B', () => {
    const A2 = { f0: 110.2, B: 4e-4 }, BA1 = 6e-4;
    const f = pureLow(A2, BA1, 3);
    expect(Math.abs(readCents(33, f, BA1, { 45: A2 }, 0.05))).toBeLessThan(0.4);
    // la même note visée en 4:2 tomberait plus haut : l’écart entre les deux types est bien pris en compte
    expect(pureLow(A2, BA1, 3)).toBeLessThan(pureLow(A2, BA1, 2));
  });

  it('aigus en 4:2 : La5 sur La4', () => {
    const A4 = { f0: 440, B: 1e-3 }, BA5 = 3e-3;
    const f = pureHigh(A4, BA5, 2);
    expect(Math.abs(readCents(81, f, BA5, { 69: A4 }))).toBeLessThan(0.3);
  });

  it('partition : Do4 à 3 demi-tons égaux au-dessus de La3 dans l’octave réelle La3–La4', () => {
    const A3 = { f0: 220, B: 8e-4 }, A4 = { f0: 440.6, B: 1e-3 }, BC4 = 9e-4;
    const lo = partial(A3, 1), hi = partial(A4, 1), f1 = lo * (hi / lo) ** (3 / 12);
    const f = f1 / Math.sqrt(1 + BC4);
    expect(Math.abs(readCents(60, f, BC4, { 57: A3, 69: A4 }))).toBeLessThan(0.3);
    expect(midiToFreq(60)).toBeGreaterThan(0);
  });
});
