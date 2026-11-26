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
