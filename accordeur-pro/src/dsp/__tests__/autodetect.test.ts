import { describe, expect, it } from 'vitest';
import { run, scenario, lastFused, centsBetween } from './synth';
import { BCurve, REFERENCE_NOTES, midiToFreq, noteName } from '..';

// piano plausible type GB1 (voir pianos.test.ts)
const GB1 = new BCurve(REFERENCE_NOTES.map((m, i) => ({ midi: m, B: [1.3e-3, 8.5e-4, 5.5e-4, 9.0e-4, 8.0e-4, 1.1e-3, 1.9e-3][i] })));
const notes = [21, 28, 35, 41, 48, 55, 62, 69, 76, 82, 89, 96, 101];

describe('détection automatique de la note (sans touche visée)', () => {
  it.each(notes)('touche %i', midi => {
    const detune = ((midi * 37) % 41) - 20;                 // −20..+20 ct, différent selon la touche
    const f0 = midiToFreq(midi) * Math.pow(2, detune / 1200);
    const { signal } = scenario({ f0, B: GB1.at(midi), kMin: midi < 36 ? 2 : 1, kMax: 12, dur: 3 }, { seed: midi });
    const fused = lastFused(run(signal, undefined).events);
    expect(fused, `${noteName(midi)} non détectée`).toBeDefined();
    console.log(`${noteName(midi)} (${midi}) : détectée ${fused!.note.name}, ${fused!.note.cents.toFixed(2)} ct (vrai ${detune} ct)`);
    expect(fused!.note.midi).toBe(midi);
    expect(Math.abs(centsBetween(fused!.f0, f0))).toBeLessThan(0.1);
  });
});
