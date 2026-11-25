import { midiToFreq } from './inharmonicityEngine';

/** Les 7 notes repères de la calibration rapide : A0, F1, D2, C3, A3, F4, C5. */
export const REFERENCE_NOTES = [21, 29, 38, 48, 57, 65, 72] as const;
export const REFERENCE_NAMES = ['A0', 'F1', 'D2', 'C3', 'A3', 'F4', 'C5'] as const;
export const FIRST_KEY = 21; // A0
export const LAST_KEY = 108; // C8

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (midi: number): string => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

export interface BMeasurement { midi: number; B: number }

/* ---------- Interpolation monotone (PCHIP, Fritsch–Carlson) ---------- */
function pchipSlopes(x: number[], y: number[]): number[] {
  const n = x.length, d = new Array(n).fill(0);
  if (n < 2) return d;
  const h: number[] = [], s: number[] = [];
  for (let i = 0; i < n - 1; i++) { h.push(x[i + 1] - x[i]); s.push((y[i + 1] - y[i]) / h[i]); }
  if (n === 2) { d[0] = d[1] = s[0]; return d; }
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] * s[i] <= 0) d[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / s[i - 1] + w2 / s[i]);
    }
  }
  const edge = (h0: number, h1: number, s0: number, s1: number) => {
    let v = ((2 * h0 + h1) * s0 - h0 * s1) / (h0 + h1);
    if (Math.sign(v) !== Math.sign(s0)) v = 0;
    else if (Math.sign(s0) !== Math.sign(s1) && Math.abs(v) > 3 * Math.abs(s0)) v = 3 * s0;
    return v;
  };
  d[0] = edge(h[0], h[1], s[0], s[1]);
  d[n - 1] = edge(h[n - 2], h[n - 3], s[n - 2], s[n - 3]);
  return d;
}

class Spline {
  private d: number[];
  constructor(private x: number[], private y: number[], private maxExtrapSlope = Infinity) { this.d = pchipSlopes(x, y); }
  /** Interpole entre les points, prolonge en droite (pente de bord) au-delà. */
  at(t: number): number {
    const { x, y, d } = this, n = x.length;
    if (n === 1) return y[0];
    const m = this.maxExtrapSlope, clamp = (v: number) => Math.max(-m, Math.min(m, v));
    if (t <= x[0]) return y[0] + clamp(d[0]) * (t - x[0]);
    if (t >= x[n - 1]) return y[n - 1] + clamp(d[n - 1]) * (t - x[n - 1]);
    let i = 0; while (t > x[i + 1]) i++;
    const h = x[i + 1] - x[i], u = (t - x[i]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    return h00 * y[i] + h10 * h * d[i] + h01 * y[i + 1] + h11 * h * d[i + 1];
  }
}

export interface BCurveOptions {
  /** Dernière note à cordes filées (la première touche à cordes en acier nu est breakMidi + 1). Défaut : 43 (G2). */
  breakMidi?: number;
}

/**
 * Courbe d'inharmonicité B(n) des 88 touches, interpolée en ln B à partir de quelques mesures.
 * Deux segments indépendants : cordes filées (graves) et cordes en acier nu (médiums/aigus),
 * car B ne varie pas de façon continue au passage de la barre des graves.
 */
export class BCurve {
  readonly breakMidi: number;
  private bass: Spline | null;
  private treble: Spline | null;
  readonly measurements: BMeasurement[];

  constructor(measurements: BMeasurement[], opts: BCurveOptions = {}) {
    const ms = measurements.filter(m => Number.isFinite(m.B) && m.B > 0).sort((a, b) => a.midi - b.midi);
    if (ms.length < 4) throw new Error('Calibration : au moins 4 mesures de B sont nécessaires (7 notes repères conseillées)');
    this.measurements = ms;
    this.breakMidi = opts.breakMidi ?? 43;
    const lnB = (m: BMeasurement) => Math.log(m.B);
    const bass = ms.filter(m => m.midi <= this.breakMidi), treble = ms.filter(m => m.midi > this.breakMidi);
    // Au-delà de la dernière mesure, B ne peut pas croître de façon explosive : pente bornée à ln(2,5)/12 par demi-ton
    // (B × 2,5 par octave, ordre de grandeur des mesures dans l'aigu).
    const mk = (a: BMeasurement[]) => (a.length ? new Spline(a.map(m => m.midi), a.map(lnB), Math.log(2.5) / 12 * 1.2) : null);
    this.bass = mk(bass); this.treble = mk(treble);
    // un seul côté mesuré : on ne peut pas modéliser le décrochage, une seule courbe sert partout
    if (!this.bass) this.bass = mk(ms);
    if (!this.treble) this.treble = mk(ms);
    // un seul point d'un côté : pas de pente, on emprunte celle de l'autre côté
    if (bass.length === 1 && treble.length > 1) this.bass = new Spline([bass[0].midi, bass[0].midi + 1], [lnB(bass[0]), lnB(bass[0]) + (this.treble!.at(this.breakMidi + 2) - this.treble!.at(this.breakMidi + 1))]);
  }

  /** B de la touche MIDI donnée (borné à [2e-5 ; 0,1]). */
  at(midi: number): number {
    const s = midi <= this.breakMidi ? this.bass! : this.treble!;
    return Math.min(0.1, Math.max(2e-5, Math.exp(s.at(midi))));
  }
}

/* ---------- Cibles d'accordage par minimisation des battements ---------- */

export type StretchPreset = 'doux' | 'standard' | 'concert';

/** Poids des coïncidences de partiels. oct21 : 2:1, oct42 : 4:2, oct63 : 6:3, fifth : 3:2 (quinte), twelfth : 3:1 (douzième). */
export interface BeatWeights { oct21: number; oct42: number; oct63: number; fifth: number; twelfth: number }

export const PRESETS: Record<StretchPreset, BeatWeights> = {
  doux:     { oct21: 1.0, oct42: 0.35, oct63: 0,    fifth: 0.1, twelfth: 0 },
  standard: { oct21: 0.3, oct42: 1.0,  oct63: 0.35, fifth: 0.1, twelfth: 0.15 },
  concert:  { oct21: 0.1, oct42: 0.5,  oct63: 1.0,  fifth: 0.1, twelfth: 0.3 },
};

export interface TuningOptions {
  stretch?: StretchPreset;
  /** Surcharge de certains poids du préréglage */
  weights?: Partial<BeatWeights>;
  la4?: number;
  /** Poids de la régularisation (courbure de la courbe d'étirement) ; garde le tempérament égal */
  smoothness?: number;
}

export interface TuningTarget {
  midi: number;
  name: string;
  B: number;
  /** Fondamentale cible (Hz) */
  f0: number;
  f0ET: number;
  /** Étirement par rapport au tempérament égal (cents) */
  centsFromET: number;
}

interface Constraint { lo: number; hi: number; p: number; q: number; span: number; w: number }

/**
 * Pour chaque touche, la fondamentale cible f0 = f0_ET · 2^(c/1200). Les inconnues c (cents d'étirement) sont
 * choisies pour que les partiels qui doivent coïncider coïncident au mieux, au sens des moindres carrés :
 *  - octave j : partiel 2j de la note grave contre partiel j de la note à l'octave (j = 1, 2, 3 -> 2:1, 4:2, 6:3)
 *  - quinte : partiel 3j contre 2j (note +7) ; douzième : partiel 3 contre 1 (note +19)
 * Le terme d'inharmonicité de chaque équation est 600·log2((1+B·p²)/(1+B'·q²)). Les constantes du tempérament égal
 * (quinte -1,955 ct...) sont retirées : on cherche l'étirement, pas à purifier les quintes. Une pénalité de
 * courbure conserve les intervalles du tempérament égal à l'intérieur de chaque octave. La touche A4 est fixée.
 */
export function computeTuningTargets(curve: BCurve, opts: TuningOptions = {}): TuningTarget[] {
  const la4 = opts.la4 ?? 440, lambda = opts.smoothness ?? 0.5;
  const W: BeatWeights = { ...PRESETS[opts.stretch ?? 'standard'], ...opts.weights };
  const N = LAST_KEY - FIRST_KEY + 1;
  const B = Array.from({ length: N }, (_, i) => curve.at(FIRST_KEY + i));

  const cons: Constraint[] = [];
  const add = (span: number, p: number, q: number, w: number) => {
    if (w <= 0) return;
    for (let lo = 0; lo + span < N; lo++) cons.push({ lo, hi: lo + span, p, q, span, w });
  };
  add(12, 2, 1, W.oct21); add(12, 4, 2, W.oct42); add(12, 6, 3, W.oct63);
  add(7, 3, 2, W.fifth); add(19, 3, 1, W.twelfth);

  // Équations normales (N×N) A c = b
  const A = Array.from({ length: N }, () => new Float64Array(N));
  const b = new Float64Array(N);
  for (const c of cons) {
    const t = 600 * Math.log2((1 + B[c.lo] * c.p * c.p) / (1 + B[c.hi] * c.q * c.q));
    // r = c_lo - c_hi + t
    A[c.lo][c.lo] += c.w; A[c.hi][c.hi] += c.w; A[c.lo][c.hi] -= c.w; A[c.hi][c.lo] -= c.w;
    b[c.lo] -= c.w * t; b[c.hi] += c.w * t;
  }
  for (let i = 1; i < N - 1; i++) { // (c_{i-1} - 2c_i + c_{i+1})² * lambda
    const idx = [i - 1, i, i + 1], co = [1, -2, 1];
    for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) A[idx[a]][idx[d]] += lambda * co[a] * co[d];
  }
  const anchor = 69 - FIRST_KEY;
  A[anchor][anchor] += 1e6; // c(A4) = 0
  const c = solveSPD(A, b);

  return Array.from({ length: N }, (_, i) => {
    const midi = FIRST_KEY + i, f0ET = midiToFreq(midi, la4);
    return { midi, name: noteName(midi), B: B[i], f0: f0ET * Math.pow(2, c[i] / 1200), f0ET, centsFromET: c[i] };
  });
}

/** Fréquence cible du partiel k d'une touche. */
export function targetPartialHz(t: TuningTarget, k: number): number {
  return k * t.f0 * Math.sqrt(1 + t.B * k * k);
}

/** Battement (Hz) entre le partiel p de la touche grave et le partiel q de la touche aiguë, aux cibles données. */
export function beatHz(lo: TuningTarget, hi: TuningTarget, p: number, q: number): number {
  return Math.abs(targetPartialHz(lo, p) - targetPartialHz(hi, q));
}

/** Cholesky pour matrice symétrique définie positive. */
function solveSPD(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length, L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 0) throw new Error('Système d’accordage mal conditionné'); L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}
