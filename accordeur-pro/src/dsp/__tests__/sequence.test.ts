import { describe, expect, it } from 'vitest';
import { AudioProcessor } from '../audioProcessor';
import { NoteTracker } from '../noteTracker';
import { BCurve, REFERENCE_NOTES, midiToFreq, noteName } from '..';
import { SR, rng, synthNote, whiteNoise, add } from './synth';
import type { ProcessorEvent } from '../types';

/**
 * Accord complet simulé 1 → 88 avec la détection intelligente :
 * piano désaccordé (une zone à remonter de 40–70 ct), plusieurs frappes par note pendant qu'on tourne la cheville,
 * fondamentale très faible sur une partie des notes (piège à octave), puis quelques sauts volontaires.
 */
const GB1 = new BCurve(REFERENCE_NOTES.map((m, i) => ({ midi: m, B: [1.3e-3, 8.5e-4, 5.5e-4, 9.0e-4, 8.0e-4, 1.1e-3, 1.9e-3][i] })));

interface Strike { midi: number; cents: number; dur: number; k1Gain: number; gap: number }
interface Outcome { strike: Strike; firstKey?: number; firstMs?: number; keys: number[]; final?: number; tentativeFirst?: boolean; cents?: number }

function sessionStrikes(seed: number): Strike[] {
  const r = rng(seed), out: Strike[] = [];
  for (let m = 21; m <= 108; m++) {
    // zone C3–C5 très basse (remontée), ailleurs ±30 ct
    const d0 = m >= 48 && m <= 72 ? -40 - 30 * r.u() : (r.u() * 2 - 1) * 30;
    const k1Gain = r.u() < 0.3 ? 0.08 : 1;
    const dur = m < 45 ? 1.6 : m < 64 ? 1.1 : 0.7;
    for (const c of [d0, d0 * 0.35, (r.u() * 2 - 1) * 0.8]) out.push({ midi: m, cents: c, dur, k1Gain, gap: 0.35 });
  }
  return out;
}

function play(strikes: Strike[], tracker: NoteTracker): Outcome[] {
  const proc = new AudioProcessor({ sampleRate: SR });
  proc.setTracker(tracker);
  const outs: Outcome[] = [];
  let cur: Outcome | null = null, onsetT = 0;
  const feed = (sig: Float32Array) => {
    for (let i = 0; i < sig.length; i += 2048) {
      for (const e of proc.push(sig.subarray(i, Math.min(sig.length, i + 2048)))) handle(e);
    }
  };
  const handle = (e: ProcessorEvent) => {
    if (!cur) return;
    if (e.frame) {
      if (cur.firstKey === undefined) { cur.firstKey = e.frame.note.midi; cur.firstMs = (e.time - onsetT) * 1000; cur.tentativeFirst = e.frame.note.tentative; }
      cur.keys.push(e.frame.note.midi);
    }
    if (e.committed) { cur.final = e.committed.midi; cur.cents = e.committed.cents; }
  };
  feed(whiteNoise(0.8, 3e-4, seed0));
  strikes.forEach((s, i) => {
    cur = { strike: s, keys: [] };
    outs.push(cur);
    const f0 = midiToFreq(s.midi) * Math.pow(2, s.cents / 1200);
    const note = synthNote({ f0, B: GB1.at(s.midi), kMin: s.midi < 36 ? 2 : 1, kMax: 14, dur: s.dur, k1Gain: s.k1Gain }, 1000 + i);
    const sig = add(whiteNoise(s.dur + s.gap, 3e-4, 2000 + i), note);
    onsetT = proc.samplesSeen / SR;
    feed(sig);
  });
  return outs;
}
let seed0 = 5;

describe('accord complet 1 → 88 avec suivi de séquence', () => {
  const outs = play(sessionStrikes(7), new NoteTracker());

  it('zéro erreur de touche (donc zéro erreur d’octave) sur les 264 frappes', () => {
    const bad = outs.filter(o => o.final !== o.strike.midi || o.keys.some(k => k !== o.strike.midi));
    for (const o of bad.slice(0, 15)) console.log(`${noteName(o.strike.midi)} ${o.strike.cents.toFixed(0)} ct : lu ${o.keys.map(noteName).join(',')} → ${o.final !== undefined ? noteName(o.final) : '—'}`);
    expect(outs.every(o => o.final !== undefined)).toBe(true);
    expect(bad.length).toBe(0);
  });

  it('première lecture < 250 ms dans les aigus, < 600 ms dans les graves', () => {
    const lat = (lo: number, hi: number) => outs.filter(o => o.strike.midi >= lo && o.strike.midi <= hi).map(o => o.firstMs ?? Infinity);
    const stats = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return { med: s[s.length >> 1], max: s[s.length - 1] }; };
    const bass = stats(lat(21, 44)), mid = stats(lat(45, 63)), treble = stats(lat(64, 108));
    console.log(`délai première lecture (ms) : graves méd ${bass.med.toFixed(0)} max ${bass.max.toFixed(0)} · médium méd ${mid.med.toFixed(0)} max ${mid.max.toFixed(0)} · aigus méd ${treble.med.toFixed(0)} max ${treble.max.toFixed(0)}`);
    expect(bass.max).toBeLessThan(600);
    expect(mid.max).toBeLessThan(600);
    expect(treble.max).toBeLessThan(250);
  });

  it('précision finale meilleure que 0,3 ct', () => {
    const errs = outs.map(o => Math.abs((o.cents ?? 99) - o.strike.cents));
    console.log(`écart final max ${Math.max(...errs).toFixed(3)} ct`);
    expect(Math.max(...errs)).toBeLessThan(0.3);
  });
});

describe('grands sauts (ancien mode : confirmation en 2 ou 3 frappes)', () => {
  const base: Strike = { midi: 60, cents: 0, dur: 1.1, k1Gain: 1, gap: 0.35 };
  it('un saut A4 → C2 n’est accepté qu’à la 2e frappe (1re lecture provisoire)', () => {
    const t = new NoteTracker({ freeFirst: false }); t.setCurrent(69);
    const o = play([{ ...base, midi: 69 }, { ...base, midi: 36, dur: 1.6 }, { ...base, midi: 36, dur: 1.6 }, { ...base, midi: 37, dur: 1.6 }], t);
    console.log(o.map(x => `${noteName(x.strike.midi)} → ${x.final !== undefined ? noteName(x.final) : '—'}${x.tentativeFirst ? ' (provisoire)' : ''}`).join(' · '));
    expect(o[1].tentativeFirst).toBe(true);
    expect(o[1].final).toBe(36);
    expect(t.current).toBe(37);
    expect(o[3].final).toBe(37);
  });
  it('une octave au-dessus de la note attendue demande 3 frappes', () => {
    const t = new NoteTracker({ freeFirst: false }); t.setCurrent(57);
    const o = play([{ ...base, midi: 57 }, { ...base, midi: 69 }, { ...base, midi: 69 }, { ...base, midi: 69 }], t);
    console.log(o.map(x => `${noteName(x.strike.midi)} → ${x.final !== undefined ? noteName(x.final) : '—'}`).join(' · '));
    expect(o[0].final).toBe(57);
    expect(t.current).toBe(69);
    expect(o[3].final).toBe(69);
  });
  it('cadenas : la touche ne bouge pas, même si on joue la voisine', () => {
    const t = new NoteTracker(); t.setCurrent(60); t.setLocked(true);
    const o = play([{ ...base, midi: 60, cents: 30 }, { ...base, midi: 61, cents: -40 }], t);
    expect(o.map(x => x.final)).toEqual([60, 60]);
    expect(o[1].cents).toBeCloseTo(60, 0);
  });
});

describe('retour en arrière', () => {
  it('B3 juste puis A3 à −30 ct (deux demi-tons plus bas, au bord de la fenêtre) : lu A3', () => {
    const t = new NoteTracker(); t.setCurrent(58);
    const base: Strike = { midi: 59, cents: 0, dur: 1.1, k1Gain: 1, gap: 0.35 };
    const o = play([base, { ...base, midi: 57, cents: -30 }, { ...base, midi: 57, cents: -5 }], t);
    expect(o.map(x => x.final)).toEqual([59, 57, 57]);
    expect(o[1].keys.every(k => k === 57)).toBe(true);
  });
});

describe('une frappe suffit (défaut)', () => {
  const base: Strike = { midi: 60, cents: 0, dur: 1.1, k1Gain: 1, gap: 0.35 };
  it('saut A4 → C2 lu dès la 1re frappe, sans lecture provisoire', () => {
    const t = new NoteTracker(); t.setCurrent(69);
    const o = play([{ ...base, midi: 69 }, { ...base, midi: 36, dur: 1.6 }, { ...base, midi: 37, dur: 1.6 }], t);
    expect(o[1].firstKey).toBe(36); expect(o[1].tentativeFirst).toBeFalsy(); expect(o[1].final).toBe(36);
    expect(o[2].final).toBe(37);
  });
  it('octave au-dessus de la note attendue : lue dès la 1re frappe', () => {
    const t = new NoteTracker(); t.setCurrent(57);
    const o = play([{ ...base, midi: 57 }, { ...base, midi: 69 }], t);
    expect(o.map(x => x.final)).toEqual([57, 69]);
  });
  it('grave juste après l’aigu (fenêtre agrandie en cours de frappe)', () => {
    const t = new NoteTracker(); t.setCurrent(96);
    const o = play([{ ...base, midi: 96, dur: 0.7 }, { ...base, midi: 26, dur: 1.6, k1Gain: 0.08 }, { ...base, midi: 90, dur: 0.7 }, { ...base, midi: 23, dur: 1.6 }], t);
    expect(o.map(x => x.final)).toEqual([96, 26, 90, 23]);
  });
});
