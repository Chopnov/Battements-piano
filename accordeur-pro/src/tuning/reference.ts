/**
 * Accord sur les notes déjà accordées, sans carte d'inharmonicité.
 *
 * Chaque note laissée juste est mémorisée telle qu'elle sonne vraiment (f0 virtuelle et B mesurés sur la corde).
 * La note suivante est visée par rapport à ces notes réelles, pas par rapport à une courbe théorique :
 *  - octave : la partielle 2j de la note grave doit coïncider avec la partielle j de la note aiguë
 *    (j = 3 : octave 6:3, j = 2 : octave 4:2, j = 1 : octave 2:1). On compare la partielle mesurée en direct
 *    à la partielle mémorisée : l'inharmonicité des deux cordes est prise telle quelle ;
 *  - octave de partition : quand ses deux extrémités sont accordées (La3 et La4 par exemple), les notes
 *    intermédiaires sont 12 demi-tons égaux de cette octave réelle ;
 *  - sinon (première note, ou rien d'accordé à l'octave) : la courbe d'accord sert de repli.
 * Comme on vise la note réellement accordée, l'imprécision d'un arrêt (+0,4 ct au lieu de 0) est rattrapée par l'octave.
 */
import type { OctaveType } from './stretch';
import type { PartialMatch } from '../dsp/types';

export interface TunedNote { f0: number; B: number }
export type Tuned = Record<number, TunedNote>;

export type Plan =
  | { kind: 'octave'; ref: number; j: number; below: boolean }   // below : la note jouée est sous la référence
  | { kind: 'partition'; lo: number; hi: number }
  | { kind: 'courbe' };

export const partial = (n: TunedNote, k: number) => k * n.f0 * Math.sqrt(1 + n.B * k * k);

/** Rang j de l'octave (partielle 2j de la grave contre j de l'aiguë) selon le type choisi et la note grave de l'octave. */
export function octaveRank(lo: number, oct: OctaveType): number {
  if (oct === '2:1') return 1;
  if (oct === '4:2') return 2;
  if (oct === '6:3') return 3;
  return lo < 48 ? 3 : 2; // mixte : 6:3 sous le Do3, 4:2 au-dessus
}

/** Comment viser la touche midi, d'après les notes déjà accordées. */
export function planFor(midi: number, tuned: Tuned, oct: OctaveType): Plan {
  const up = tuned[midi + 12], down = tuned[midi - 12];
  // vers les graves on s'appuie sur la note du dessus, vers les aigus sur celle du dessous
  const fromAbove = up && (midi < 64 || !down), fromBelow = down && (midi >= 64 || !up);
  if (fromAbove) return { kind: 'octave', ref: midi + 12, j: octaveRank(midi, oct), below: true };
  if (fromBelow) return { kind: 'octave', ref: midi - 12, j: octaveRank(midi - 12, oct), below: false };
  for (let lo = midi - 11; lo < midi; lo++) if (tuned[lo] && tuned[lo + 12]) return { kind: 'partition', lo, hi: lo + 12 };
  return { kind: 'courbe' };
}

/** Fréquence mesurée de la partielle k : le pic réellement trouvé s'il y en a un, sinon le modèle f0, B de la fenêtre. */
export function measuredPartial(f0: number, B: number, k: number, partials?: PartialMatch[]): number {
  const p = partials?.find(x => x.k === k && Math.abs(x.residualCents) < 15);
  return p ? p.freq : k * f0 * Math.sqrt(1 + B * k * k);
}

/** Écart (cents) de la note jouée à sa cible d'après le plan ; null pour le repli sur la courbe. */
export function centsFromPlan(plan: Plan, midi: number, tuned: Tuned, f0: number, B: number, partials?: PartialMatch[]): number | null {
  if (plan.kind === 'octave') {
    const ref = tuned[plan.ref], j = plan.j;
    const cur = measuredPartial(f0, B, plan.below ? 2 * j : j, partials);
    const tgt = partial(ref, plan.below ? j : 2 * j);
    return 1200 * Math.log2(cur / tgt);
  }
  if (plan.kind === 'partition') {
    const lo = partial(tuned[plan.lo], 1), hi = partial(tuned[plan.hi], 1);
    const tgt = lo * Math.pow(hi / lo, (midi - plan.lo) / 12);
    return 1200 * Math.log2((f0 * Math.sqrt(1 + B)) / tgt);
  }
  return null;
}

const FR = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];
const lab = (m: number) => FR[m % 12] + (Math.floor(m / 12) - 1);
export function planLabel(p: Plan): string {
  if (p.kind === 'octave') return `octave ${2 * p.j}:${p.j} sur ${lab(p.ref)}`;
  if (p.kind === 'partition') return `partition ${lab(p.lo)}–${lab(p.hi)}`;
  return 'courbe';
}

/* ---------- Cible par compromis entre plusieurs intervalles ---------- */

/** Un intervalle avec une note déjà accordée : écart (cents) de la note jouée à ce que demande cet intervalle seul. */
export interface Constraint { label: string; ref: number; cents: number; weight: number; /** octave, double octave, partition : décide de la cible */ primary?: boolean; /** compté dans le compromis */ used?: boolean; /** battement de cet intervalle (Hz, signé : + si la note jouée est trop haute) */ beatHz?: number }

interface Kind { d: number; name: string; p: (lo: number) => [number, number]; et: number; w: number }
// p : partielles qui doivent coïncider (grave, aiguë) ; et : écart voulu en tempérament égal sur ces partielles (cents, note aiguë vs pure)
const KINDS = (oct: OctaveType): Kind[] => [
  { d: 12, name: 'octave', p: lo => { const j = octaveRank(lo, oct); return [2 * j, j]; }, et: 0, w: 1 },
  // double octave et douzième sur les mêmes partielles que les octaves choisies (sinon elles contredisent l'octave : ~8 ct à B = 1e-3)
  { d: 24, name: 'double octave', p: lo => { const j = octaveRank(lo, oct); return [4 * j, j]; }, et: 0, w: 0.5 },
  { d: 19, name: 'douzième', p: lo => { const j = octaveRank(lo, oct); return [3 * j, j]; }, et: 0, w: 0.4 },
  { d: 7, name: 'quinte', p: lo => (lo < 48 ? [6, 4] : [3, 2]), et: -1.955, w: 0.25 },
  { d: 5, name: 'quarte', p: lo => (lo < 48 ? [8, 6] : [4, 3]), et: 1.955, w: 0.15 },
];

/** Tous les intervalles utilisables pour viser la touche midi, avec la mesure en cours (f0, B et pics de la fenêtre). */
export function constraintsFor(midi: number, tuned: Tuned, oct: OctaveType, f0: number, B: number, partials?: PartialMatch[]): Constraint[] {
  const out: Constraint[] = [];
  const found = (k: number) => !!partials?.find(x => x.k === k && Math.abs(x.residualCents) < 15);
  for (const K of KINDS(oct)) {
    for (const sgn of [1, -1]) {
      const r = midi + sgn * K.d, ref = tuned[r];
      if (!ref || r === midi) continue;
      const lo = Math.min(midi, r), [pLo, pHi] = K.p(lo), playedIsLo = midi === lo;
      // double octave à cheval sur deux types d'octave (6:3 puis 4:2) : pas de partielles cohérentes avec les deux, on s'en passe
      if (K.d === 24 && octaveRank(lo, oct) !== octaveRank(lo + 12, oct)) continue;
      const kPlayed = playedIsLo ? pLo : pHi, kRef = playedIsLo ? pHi : pLo;
      const mp = measuredPartial(f0, B, kPlayed, partials), want = playedIsLo ? -K.et : K.et;
      const raw = 1200 * Math.log2(mp / partial(ref, kRef));
      // note jouée en haut : elle doit être à « et » de la pure ; en bas : à −et
      const cents = raw - want;
      const beatHz = mp - partial(ref, kRef) * Math.pow(2, want / 1200);
      const label = K.name === 'octave' ? `octave ${pLo}:${pHi} sur ${lab(r)}` : `${K.name} sur ${lab(r)}`;
      out.push({ label, ref: r, cents, beatHz, weight: K.w * (found(kPlayed) ? 1 : 0.5), primary: K.d === 12 || K.d === 24 });
    }
  }
  // octave de partition : 12 demi-tons égaux entre ses deux extrémités accordées
  for (let lo = midi - 11; lo < midi; lo++) {
    if (!tuned[lo] || !tuned[lo + 12]) continue;
    const a = partial(tuned[lo], 1), b = partial(tuned[lo + 12], 1), tgt = a * Math.pow(b / a, (midi - lo) / 12);
    out.push({ label: `partition ${lab(lo)}–${lab(lo + 12)}`, ref: lo, cents: 1200 * Math.log2((f0 * Math.sqrt(1 + B)) / tgt), weight: 1, primary: true });
    break;
  }
  return out;
}

export interface Combined { cents: number; spread: number; label: string; parts: Constraint[]; /** intervalle principal et son battement */ main: Constraint }

/**
 * Compromis pondéré. Une référence qui contredit nettement les autres (note qui a bougé) est mise de côté :
 * on retire les contraintes à plus de 3 ct de la médiane pondérée. Les intervalles non retenus restent affichés comme contrôle.
 */
export function combine(cs: Constraint[]): Combined | null {
  if (!cs.length) return null;
  // Les octaves (et doubles octaves, octave de partition) décident. Quintes, quartes et douzièmes ne comptent que s'il n'y a
  // aucune octave accordée : sur cordes inharmoniques elles tirent les octaves de plusieurs cents (accord simulé : 0,5 → 2 ct).
  const pool = cs.some(c => c.primary) ? cs.filter(c => c.primary) : cs;
  const wmed = (a: Constraint[]) => {
    const s = [...a].sort((x, y) => x.cents - y.cents), tot = s.reduce((t, c) => t + c.weight, 0);
    let acc = 0; for (const c of s) { acc += c.weight; if (acc >= tot / 2) return c.cents; }
    return s[s.length - 1].cents;
  };
  const med = wmed(pool);
  let kept = pool.filter(c => Math.abs(c.cents - med) <= 3);
  if (!kept.length) kept = pool;
  const W = kept.reduce((t, c) => t + c.weight, 0);
  const cents = kept.reduce((t, c) => t + c.weight * c.cents, 0) / W;
  const spread = Math.sqrt(pool.reduce((t, c) => t + c.weight * (c.cents - cents) ** 2, 0) / pool.reduce((t, c) => t + c.weight, 0));
  const parts = cs.map(c => ({ ...c, used: kept.includes(c) }));
  const main = [...kept].sort((a, b) => b.weight - a.weight)[0];
  const label = main.label + (kept.length > 1 ? ` + ${kept.length - 1} autre${kept.length > 2 ? 's' : ''}` : '');
  return { cents, spread, label, parts, main };
}

/**
 * Test tierce mineure + sixte majeure de l'octave lo–lo+12 (la note du milieu est lo+3) : battements (b/s)
 * de la tierce (partielles 6 de lo et 5 du milieu) et de la sixte (5 du milieu et 3 de l'aiguë). Égaux = octave 6:3 pure.
 */
export function test3m6M(lo: number, loNote: TunedNote, tuned: Tuned): { mid: number; hi: number; m3: number; M6: number } | null {
  const mid = tuned[lo + 3], hi = tuned[lo + 12];
  if (!mid || !hi) return null;
  return { mid: lo + 3, hi: lo + 12, m3: Math.abs(partial(loNote, 6) - partial(mid, 5)), M6: Math.abs(partial(mid, 5) - partial(hi, 3)) };
}
export const noteLabel = lab;
