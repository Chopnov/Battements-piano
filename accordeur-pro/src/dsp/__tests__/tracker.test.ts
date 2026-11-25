import { describe, expect, it } from 'vitest';
import { NoteTracker } from '../noteTracker';
import { Recorder, readWav } from '../recorder';
import { midiToFreq } from '../inharmonicityEngine';
import type { FitResult } from '../types';

const fit = (midi: number, cents = 0): { fit: FitResult; score: number } => ({
  score: 0.9,
  fit: { f0: midiToFreq(midi) * Math.pow(2, cents / 1200), B: 1e-3, sigmaF0Cents: 0.1, sigmaB: 0, partials: [], rmsCents: 0.1, coherence: 0.95, fundamentalUsed: true },
});
/** Une frappe : n fenêtres guidées, puis éventuellement des fenêtres où seule la détection libre répond */
function strike(t: NoteTracker, midi: number, cents: number, opts: { frames?: number; tailFree?: number; tailCents?: number } = {}) {
  t.beginStrike();
  const atts = [];
  for (let i = 0; i < (opts.frames ?? 5); i++) atts.push(t.observe(fit(midi, cents), i < 2 ? fit(midi, cents) : null));
  for (let i = 0; i < (opts.tailFree ?? 0); i++) atts.push(t.observe({ rejected: 'poor-fit' }, fit(opts.tailCents ?? midi + 12)));
  return { atts, c: t.commit()! };
}

describe('suivi de séquence (logique pure)', () => {
  it('glissement : après une note juste, la suivante très basse (−70 ct) n’est pas prise pour la précédente', () => {
    const t = new NoteTracker(); t.setCurrent(60);
    strike(t, 60, 0.5);
    const { c } = strike(t, 61, -70);
    expect(c.midi).toBe(61); expect(c.correction).toBe('glissement'); expect(c.cents).toBeCloseTo(-70, 1);
  });
  it('continuité : une note pas encore juste qui passe −50 ct reste la même touche', () => {
    const t = new NoteTracker(); t.setCurrent(60);
    strike(t, 61, -60);                     // C♯4 à −60 ct, C4 pas encore mesuré juste : pas de glissement possible
    expect(t.current).toBe(60);             // sans note juste avant, la plus proche gagne (C4 +40)
    t.nudge(1);                             // l'accordeur corrige à la main
    const { c } = strike(t, 61, -55);
    expect(c.midi).toBe(61); expect(c.correction).toBe('continuite');
  });
  it('une lecture libre isolée en fin de frappe (octave) ne change pas la touche', () => {
    const t = new NoteTracker(); t.setCurrent(58);
    const { c } = strike(t, 59, 12, { frames: 30, tailFree: 3, tailCents: 71 });
    expect(c.midi).toBe(59); expect(t.current).toBe(59); expect(c.cents).toBeCloseTo(12, 1);
  });
  it('cadenas et flèches', () => {
    const t = new NoteTracker(); t.setCurrent(40); t.setLocked(true);
    strike(t, 41, 0);
    expect(t.current).toBe(40);
    t.nudge(1); expect(t.current).toBe(41);
    expect(t.isLocked).toBe(true);
  });
});

describe('enregistreur', () => {
  it('WAV 24 bits relu à l’identique et journal horodaté', () => {
    const sr = 48000, x = new Float32Array(sr * 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
    const r = new Recorder(sr, 1000);
    r.push(x.subarray(0, 30000)); r.push(x.subarray(30000));
    r.note('frappe', 1000 + 48000, { note: 'A4', cents: 0.3 });
    const back = readWav(r.wav());
    expect(back.sampleRate).toBe(sr); expect(back.data.length).toBe(x.length);
    let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(back.data[i] - x[i]));
    expect(err).toBeLessThan(2e-7);
    const j = JSON.parse(r.journal());
    expect(j.journal[0]).toMatchObject({ t: 1, sample: 48000, type: 'frappe', note: 'A4' });
  });
});
