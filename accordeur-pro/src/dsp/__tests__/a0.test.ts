import { describe, expect, it } from 'vitest';
import { run, scenario, lastFused, centsBetween, SR } from './synth';

describe('La0 (27,5 Hz) : fondamentale absente, fort B', () => {
  // La0 légèrement bas (−6 ct) et B fort (petit queue), k=1 NON généré
  const f0 = 27.5 * Math.pow(2, -6 / 1200), B = 1.2e-3;
  const { signal, onsetSample } = scenario({ f0, B, kMin: 2, kMax: 14, dur: 3.5 }, { seed: 3 });
  const { events } = run(signal, 21);
  const fused = lastFused(events)!;

  it('retrouve f0 virtuelle sans le pic k=1', () => {
    expect(fused).toBeDefined();
    const err = centsBetween(fused.f0, f0);
    console.log(`La0 : f0 ${fused.f0.toFixed(4)} Hz, erreur ${err.toFixed(3)} ct, σ ${fused.sigmaF0Cents.toFixed(3)} ct, ${fused.frames} fenêtres`);
    expect(Math.abs(err)).toBeLessThan(0.1); // exigence : résolution < 0,1 ct
    expect(fused.fundamentalUsed).toBe(false);
  });

  it('retrouve B à quelques % près', () => {
    const rel = Math.abs(fused.B - B) / B;
    console.log(`La0 : B ${fused.B.toExponential(3)} (vrai ${B.toExponential(1)}), erreur ${(rel * 100).toFixed(2)} %`);
    expect(rel).toBeLessThan(0.03);
  });

  it('n’utilise jamais k=1 et s’appuie sur k=3..6 en priorité', () => {
    const frames = events.filter(e => e.frame).map(e => e.frame!);
    expect(frames.length).toBeGreaterThan(3);
    for (const f of frames) {
      expect(f.fit.partials.some(p => p.k === 1)).toBe(false);
      const w36 = f.fit.partials.filter(p => p.k >= 3 && p.k <= 6).reduce((a, p) => a + p.weight, 0);
      const wOther = f.fit.partials.filter(p => p.k < 3 || p.k > 6).reduce((a, p) => a + p.weight, 0);
      expect(w36).toBeGreaterThan(wOther);
    }
  });

  it('ignore les 40 premières ms de l’attaque', () => {
    const first = events.find(e => e.frame)!.frame!;
    expect(first.startSample).toBeGreaterThanOrEqual(onsetSample + 0.04 * SR);
    // aucune fenêtre ne doit contenir le bruit de marteau
    for (const e of events) if (e.frame) expect(e.frame.startSample).toBeGreaterThanOrEqual(onsetSample + 0.04 * SR);
  });

  it('gèle la mesure quand le signal retombe', () => {
    const iFrozen = events.findIndex(e => e.frozenNow);
    expect(iFrozen).toBeGreaterThan(0);
    const after = events.slice(iFrozen);
    expect(after.every(e => e.state === 'frozen')).toBe(true);
    expect(after.every(e => e.fused && e.fused.f0 === after[0].fused!.f0)).toBe(true);
  });
});
