import { describe, expect, it } from 'vitest';
import { rng } from './synth';
import { constraintsFor, combine, partial, octaveRank, type Tuned } from '../../tuning/reference';
import { stretchCurve } from '../../tuning/stretch';

/**
 * Accord complet simulé (sans audio) : un vrai piano (B par corde, avec des irrégularités), un accordeur qui s'arrête à
 * ±0,5 ct près de ce que montre l'appareil. On compare l'écart des octaves (sur les partielles qui doivent coïncider)
 * entre (a) une courbe calculée d'avance avec un B estimé à ±25 % près et (b) la visée sur les notes déjà accordées.
 */
const et = (m: number) => 440 * 2 ** ((m - 69) / 12);
function piano(seed: number) {
  const r = rng(seed), B: number[] = [];
  for (let m = 21; m <= 108; m++) {
    const k = m - 20, base = k > 28 ? 3.6e-4 * 10 ** ((k - 40) * 0.0285) : 3.6e-4 * 10 ** ((29 - 40) * 0.0285) * 1.25 * 10 ** ((28 - k) * 0.024);
    B[m] = base * (1 + 0.12 * r.g());
  }
  return B;
}
const order = (): number[] => {
  const o = [69, 57]; for (let m = 58; m < 69; m++) o.push(m);
  for (let m = 56; m >= 21; m--) o.push(m);
  for (let m = 70; m <= 108; m++) o.push(m);
  return o;
};
/** Écart d'octave (cents) sur les partielles 2j:j du type mixte, pour toutes les octaves. */
function octaveErrors(f0: number[], B: number[]): number[] {
  const out: number[] = [];
  for (let lo = 21; lo + 12 <= 108; lo++) {
    const j = octaveRank(lo, 'mixte');
    out.push(1200 * Math.log2(partial({ f0: f0[lo], B: B[lo] }, 2 * j) / partial({ f0: f0[lo + 12], B: B[lo + 12] }, j)));
  }
  return out;
}
const rms = (a: number[]) => Math.sqrt(a.reduce((t, x) => t + x * x, 0) / a.length);

describe('accord complet simulé : courbe estimée contre visée sur les notes accordées', () => {
  it('les octaves sont nettement plus justes en visant les notes réellement accordées', () => {
    const res = { courbe: [] as number[], notes: [] as number[] };
    for (let seed = 1; seed <= 5; seed++) {
      const B = piano(seed), r = rng(100 + seed), noise = () => 0.5 * r.g();
      // (a) courbe d'avance avec un B estimé à ±25 %
      const Best = B.map(b => b * (1 + 0.25 * r.g()));
      const dev = stretchCurve(Best, 'mixte');
      const fa: number[] = [];
      for (let m = 21; m <= 108; m++) fa[m] = et(m) * 2 ** ((dev[m] + noise()) / 1200) / Math.sqrt(1 + B[m]);
      res.courbe.push(rms(octaveErrors(fa, B)));
      // (b) visée sur les notes accordées : la note est amenée là où le compromis est nul, à ±0,5 ct près
      const tuned: Tuned = {}, fb: number[] = [];
      for (const m of order()) {
        let f = m === 69 ? 440 : et(m) * 2 ** (dev[m] / 1200) / Math.sqrt(1 + B[m]);
        for (let it = 0; it < 3; it++) { const c = combine(constraintsFor(m, tuned, 'mixte', f, B[m])); if (c) f *= 2 ** (-c.cents / 1200); }
        f *= 2 ** (noise() / 1200); fb[m] = f; tuned[m] = { f0: f, B: B[m] };
      }
      res.notes.push(rms(octaveErrors(fb, B)));
    }
    const a = rms(res.courbe), b = rms(res.notes);
    console.log(`écart d'octave moyen (rms, cents) : courbe estimée ${a.toFixed(2)} · visée sur les notes accordées ${b.toFixed(2)}`);
    expect(b).toBeLessThan(a * 0.6);
  });
});
