import { AudioProcessor } from '../audioProcessor';
import type { ProcessorEvent } from '../types';
import { partialFreq, centsBetween } from '../inharmonicityEngine';

export const SR = 48000;

export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, g };
}

export interface NoteSpec {
  f0: number;
  B: number;
  /** rang des partiels générés, ex. de 2 à 14 : le pic k=1 est ABSENT s'il n'y figure pas */
  kMin?: number;
  kMax?: number;
  /** durée de la note (s) */
  dur: number;
  /** amplitude globale */
  level?: number;
  /** durée du bruit de marteau (s) */
  hammerMs?: number;
}

/** Note de piano synthétique : partiels de Fletcher, amplitudes décroissantes avec le rang, décroissance exponentielle plus rapide dans l'aigu. */
export function synthNote(spec: NoteSpec, seed = 1): Float32Array {
  const { f0, B, dur } = spec, kMin = spec.kMin ?? 1, kMax = spec.kMax ?? 14, level = spec.level ?? 0.12;
  const n = Math.round(dur * SR), x = new Float32Array(n), r = rng(seed);
  for (let k = kMin; k <= kMax; k++) {
    const f = partialFreq(f0, B, k);
    if (f > 20000) break;
    const a = level * Math.pow(k, -0.5) * (0.5 + 0.5 * Math.abs(Math.sin(Math.PI * k / 8.3)));
    const tau = 4 / (1 + 0.3 * (k - 1)), ph = 2 * Math.PI * r.u(), w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < n; i++) x[i] += a * Math.exp(-i / SR / tau) * Math.sin(w * i + ph);
  }
  // bruit large bande du marteau : fort, très bref
  const hn = Math.round(((spec.hammerMs ?? 25) / 1000) * SR);
  for (let i = 0; i < Math.min(hn, n); i++) x[i] += 0.5 * Math.exp(-i / (hn / 3)) * r.g() * 0.5;
  return x;
}

export function whiteNoise(seconds: number, sigma: number, seed = 7): Float32Array {
  const n = Math.round(seconds * SR), x = new Float32Array(n), r = rng(seed);
  for (let i = 0; i < n; i++) x[i] = sigma * r.g();
  return x;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function add(a: Float32Array, b: Float32Array, offset = 0): Float32Array {
  const out = Float32Array.from(a);
  for (let i = 0; i < b.length && i + offset < out.length; i++) out[i + offset] += b[i];
  return out;
}

/** Signal de sinusoïdes (ronflement 50 Hz du secteur / VMC, voix) */
export function tones(seconds: number, freqs: number[], amp: number): Float32Array {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  freqs.forEach((f, j) => { for (let i = 0; i < n; i++) x[i] += (amp / (1 + 0.3 * j)) * Math.sin((2 * Math.PI * f * i) / SR + j); });
  return x;
}

/** Passe le signal dans le processeur par paquets de 2048 échantillons (comme le worklet). */
export function run(signal: Float32Array, midi: number | undefined, proc = new AudioProcessor()): { events: ProcessorEvent[]; proc: AudioProcessor } {
  proc.setTarget(midi);
  const events: ProcessorEvent[] = [];
  for (let i = 0; i < signal.length; i += 2048) events.push(...proc.push(signal.subarray(i, Math.min(signal.length, i + 2048))));
  return { events, proc };
}

export const lastFused = (ev: ProcessorEvent[]) => [...ev].reverse().find(e => e.fused)?.fused;
export { centsBetween };

/** Scénario complet : silence (bruit de fond), note, silence. Renvoie le signal et l'instant d'attaque. */
export function scenario(note: NoteSpec, opts: { lead?: number; tail?: number; noise?: number; seed?: number } = {}) {
  const lead = opts.lead ?? 1, tail = opts.tail ?? 2, noise = opts.noise ?? 3e-4;
  const total = lead + note.dur + tail;
  let sig = whiteNoise(total, noise, (opts.seed ?? 1) + 100);
  sig = add(sig, synthNote(note, opts.seed ?? 1), Math.round(lead * SR));
  return { signal: sig, onsetSample: Math.round(lead * SR) };
}
