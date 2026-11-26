/**
 * Courbe d'accord de la version d'essai : profil générique de B par type de piano, affiné par les notes mesurées,
 * puis étirement (écart au tempérament égal, en cents) calculé octave par octave depuis La3–La4.
 * Mêmes formules que la maquette de l'écran principal (ecran-principal.html).
 */

export interface PianoProfile { id: string; label: string; sub: string; b40: number; brk: number }

// ordres de grandeur, pas des mesures de modèles précis ; b40 = B au Do4 (touche 40), brk = dernière touche filée
export const PROFILES: PianoProfile[] = [
  { id: 'petit', label: 'Petit droit', sub: 'moins de 115 cm', b40: 5.2e-4, brk: 30 },
  { id: 'droit', label: 'Droit moyen', sub: '115 à 125 cm', b40: 3.6e-4, brk: 28 },
  { id: 'gdroit', label: 'Grand droit', sub: 'plus de 125 cm', b40: 2.8e-4, brk: 26 },
  { id: 'demi', label: 'Demi-queue', sub: '160 à 210 cm', b40: 2.1e-4, brk: 23 },
  { id: 'queue', label: 'Grand queue', sub: 'plus de 210 cm', b40: 1.5e-4, brk: 20 },
];

export type OctaveType = 'mixte' | '2:1' | '4:2' | '6:3';
export const OCTAVES: { id: OctaveType; label: string; sub: string }[] = [
  { id: 'mixte', label: 'Mixte', sub: '6:3 dans les graves, 4:2 ailleurs' },
  { id: '2:1', label: '2:1', sub: 'octaves serrées' },
  { id: '4:2', label: '4:2', sub: 'standard' },
  { id: '6:3', label: '6:3', sub: 'octaves larges' },
];

const key = (midi: number) => midi - 20; // 1..88

export function profileB(p: PianoProfile, midi: number): number {
  const k = key(midi), st = (j: number) => p.b40 * Math.pow(10, (j - 40) * 0.0285);
  return k > p.brk ? st(k) : st(p.brk + 1) * 1.25 * Math.pow(10, (p.brk - k) * 0.024);
}

/** Mesures de B par touche MIDI (plusieurs frappes possibles). */
export type Measures = Record<number, number[]>;

export function medianB(v: number[]): number {
  const s = v.map(Math.log).sort((a, b) => a - b), n = s.length;
  return Math.exp(n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2);
}

/** Mesure jugée douteuse si elle s'écarte de plus d'un facteur 3 du profil (cordes mortes, double battement, mauvaise note). */
export const isOutlier = (p: PianoProfile, midi: number, B: number) => Math.abs(Math.log(B / profileB(p, midi))) > Math.log(3);

/** B des 88 touches (index MIDI) : profil × correction lissée par les mesures, ramenée vers le profil là où il y a peu de notes. */
export function refinedB(p: PianoProfile, meas: Measures): number[] {
  const pts = Object.entries(meas)
    .map(([m, v]) => [Number(m), medianB(v)] as const)
    .filter(([m, B]) => !isOutlier(p, m, B))
    .map(([m, B]) => [key(m), Math.log(B / profileB(p, m))] as const);
  const out: number[] = [];
  for (let midi = 21; midi <= 108; midi++) {
    const k = key(midi);
    let sw = 0, sr = 0;
    for (const [ki, ri] of pts) {
      // pas de lissage à travers la cassure filé / acier
      if ((ki <= p.brk) !== (k <= p.brk)) continue;
      const w = Math.exp(-Math.pow((k - ki) / 9, 2)); sw += w; sr += w * ri;
    }
    out[midi] = profileB(p, midi) * Math.exp(sr / (sw + 0.35));
  }
  return out;
}

/**
 * Écart au tempérament égal (cents) de la 1re partielle de chaque touche, La4 = 0.
 * Octave La3–La4 répartie linéairement, puis octaves empilées au type choisi.
 */
export function stretchCurve(B: number[], oct: OctaveType): number[] {
  const log2 = Math.log2;
  // largeur (au-delà de 1200 ct) de l'octave lo–hi quand les partielles m de lo et m/2 de hi coïncident, mesurée sur les 1res partielles
  const one = (m: number, lo: number, hi: number) =>
    600 * log2((1 + m * m * B[lo]) / (1 + (m / 2) * (m / 2) * B[hi])) + 600 * log2((1 + B[hi]) / (1 + B[lo]));
  const width = (lo: number, hi: number) => {
    if (oct === '2:1') return one(2, lo, hi);
    if (oct === '4:2') return one(4, lo, hi);
    if (oct === '6:3') return one(6, lo, hi);
    const t = Math.max(0, Math.min(1, (56 - lo) / 24)), w = t * t * (3 - 2 * t); // touche 36 (Sol♯3) et au-dessus : 4:2 ; Sol♯1 et dessous : 6:3
    return w * one(6, lo, hi) + (1 - w) * one(4, lo, hi);
  };
  const dev: number[] = [];
  const s = width(57, 69);
  for (let m = 57; m <= 69; m++) dev[m] = -s * (69 - m) / 12;
  for (let m = 70; m <= 108; m++) dev[m] = dev[m - 12] + width(m - 12, m);
  for (let m = 56; m >= 21; m--) dev[m] = dev[m + 12] - width(m, m + 12);
  return dev;
}

/** Zone « juste » selon le registre (Hz de la touche) : ±1 ct, ±2 ct au-dessus de 1000 Hz, ±3 ct au-dessus de 2000 Hz. */
export const toleranceFor = (midi: number, la4 = 440) => {
  const hz = la4 * Math.pow(2, (midi - 69) / 12);
  return hz < 1000 ? 1 : hz < 2000 ? 2 : 3;
};

const FR = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];
export const frName = (midi: number) => ({ name: FR[midi % 12], oct: Math.floor(midi / 12) - 1 });
export const frLabel = (midi: number) => { const n = frName(midi); return n.name + n.oct; };
