import { centsBetween, midiToFreq } from './inharmonicityEngine';
import { FIRST_KEY, LAST_KEY, noteName } from './tuningCurve';
import type { FitRejection, FitResult } from './types';

/**
 * Détection de note « intelligente » : le suivi connaît la séquence d'accord.
 *
 * Principe : à chaque frappe, on cherche d'abord la fondamentale dans une fenêtre étroite autour de
 * la note courante (de c−1 à c+2 dans le sens d'accord). Dans cette fenêtre il n'existe aucun
 * rapport 2:1 ou 3:2 entre candidats : une erreur d'octave y est impossible par construction.
 * La détection libre (toute la tessiture) ne sert qu'à repérer un grand saut, accepté seulement
 * après 2 frappes concordantes (3 si le saut ressemble à une octave ou une douzième de la note attendue).
 *
 * Attribution de la touche à partir de f0 :
 * - par défaut, la touche la plus proche ;
 * - glissement : si la note courante était juste (|écart| ≤ 5 ct) et que la nouvelle frappe s'en écarte
 *   de plus de 15 ct dans le sens d'accord, c'est la touche suivante, même si elle est assez fausse
 *   pour « tomber » sur la précédente (piano à remonter de 50 ct, par exemple) ;
 * - continuité : une note pas encore juste qui franchit la frontière des ±50 ct en cours d'accord
 *   (cheville qui bouge de quelques cents) reste attribuée à la même touche.
 * Cadenas : la touche ne change plus. Flèches : corrigent la touche d'un demi-ton (cadenas + flèches = mode manuel).
 */

export interface TrackerConfig {
  /** Sens d'accord au départ : +1 = du grave vers l'aigu (1 → 88) */
  startDirection: 1 | -1;
  /** Écart sous lequel une note est considérée juste (ct) */
  tunedCents: number;
  /** Écart, depuis une note juste, à partir duquel une frappe est attribuée à la touche suivante (ct) */
  slideCents: number;
  /** Écart maximal entre deux frappes successives d'une même note pas encore juste (ct) */
  continuityCents: number;
  /** Frappes concordantes nécessaires pour accepter un grand saut */
  jumpStrikes: number;
  /** … et pour un saut d'octave, de douzième ou de double octave (suspect) */
  octaveJumpStrikes: number;
  /** La détection libre doit faire mieux que la séquence d'au moins ce rapport de score pour compter comme indice de saut */
  jumpScoreRatio: number;
  /**
   * Une frappe suffit (défaut) : la détection libre décide de la touche à chaque fenêtre ; la séquence ne sert plus
   * qu'à départager une hésitation d'octave (octave, douzième, double octave de la note attendue) et à appliquer
   * glissement / continuité près de la note courante. false = ancien comportement (saut confirmé en 2 ou 3 frappes).
   */
  freeFirst: boolean;
}

export const DEFAULT_TRACKER: TrackerConfig = {
  startDirection: 1, tunedCents: 5, slideCents: 15, continuityCents: 35,
  jumpStrikes: 2, octaveJumpStrikes: 3, jumpScoreRatio: 1.25, freeFirst: true,
};

export type Scored = { fit: FitResult; score: number } | FitRejection | null;
const ok = (r: Scored): r is { fit: FitResult; score: number } => !!r && !('rejected' in r);

/** Ce que le processeur doit analyser pour la frappe en cours. */
export interface StrikePlan {
  /** Centre (MIDI fractionnaire) de la recherche guidée ; absent = pas de recherche guidée */
  center?: number;
  searchCents: number;
  /** Lancer aussi la détection libre (repérage des grands sauts) */
  runFree: boolean;
  /** Note qui sert à choisir la taille de fenêtre (registre) */
  windowMidi?: number;
}

export type Correction = 'glissement' | 'continuite' | 'saut' | 'manuel';

/** Touche attribuée à une fenêtre d'analyse. */
export interface Attribution {
  midi: number;
  name: string;
  /** Écart de f0 à cette touche (tempérament égal), peut dépasser ±50 ct */
  cents: number;
  fit: FitResult;
  /** Lecture provisoire (grand saut pas encore confirmé) */
  tentative: boolean;
  correction?: Correction;
  source: 'sequence' | 'libre' | 'cadenas';
}

/** Bilan d'une frappe, au moment où la mesure est figée. */
export interface StrikeCommit {
  midi: number;
  name: string;
  cents: number;
  f0: number;
  B: number;
  /** Note courante après cette frappe */
  current: number;
  /** Saut en attente de confirmation : touche et nombre de frappes concordantes */
  pendingJump?: { midi: number; count: number; needed: number };
  correction?: Correction;
  tentative: boolean;
}

interface KeyReading { f0: number; cents: number }

export class NoteTracker {
  readonly cfg: TrackerConfig;
  private la4 = 440;
  private cur: number | undefined;
  private dir: 1 | -1;
  private locked = false;
  private readings = new Map<number, KeyReading>();
  private pending: { midi: number; count: number } | null = null;
  // frappe en cours
  private strike = newStrike();

  constructor(cfg: Partial<TrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACKER, ...cfg };
    this.dir = this.cfg.startDirection;
  }

  setLa4(la4: number): void { this.la4 = la4; }
  get current(): number | undefined { return this.cur; }
  get direction(): 1 | -1 { return this.dir; }
  get isLocked(): boolean { return this.locked; }
  get pendingJump(): { midi: number; count: number } | null { return this.pending; }

  /** Cadenas : la touche courante ne change plus. */
  setLocked(v: boolean): void { this.locked = v && this.cur !== undefined; }

  /** Fixe la touche courante (mode manuel, ou première note imposée). */
  setCurrent(midi: number): void {
    this.cur = clampKey(midi); this.pending = null;
  }

  /**
   * Corrige la touche d'un demi-ton (flèches). Renvoie la nouvelle touche.
   * La dernière lecture est réattribuée à la nouvelle touche pour que la continuité suive.
   */
  nudge(delta: number): number | undefined {
    if (this.cur === undefined) return undefined;
    const from = this.cur, to = clampKey(from + delta);
    const r = this.readings.get(from);
    if (r) { this.readings.delete(from); this.readings.set(to, { f0: r.f0, cents: centsBetween(r.f0, midiToFreq(to, this.la4)) }); }
    this.cur = to; this.pending = null;
    if (Math.abs(to - from) === 1) this.dir = to > from ? 1 : -1;
    return to;
  }

  /** Oublie tout (nouveau piano). */
  resetSequence(): void {
    this.cur = undefined; this.readings.clear(); this.pending = null; this.locked = false; this.dir = this.cfg.startDirection;
  }

  plan(): StrikePlan {
    if (this.cur === undefined) return { searchCents: 0, runFree: true };
    if (this.locked) return { center: this.cur, searchCents: 120, runFree: false, windowMidi: this.cur };
    // de c−2,5 à c+2,5 demi-tons : aucun rapport 2:1 ou 3:2 possible dans cette fenêtre
    return { center: this.cur, searchCents: 250, runFree: true, windowMidi: this.cur + this.dir };
  }

  beginStrike(): void { this.strike = newStrike(); }

  /** Touche dominante de la frappe en cours (la plus attribuée par la séquence), pour la fusion des fenêtres */
  get strikeKey(): number | undefined {
    if (!this.cfg.freeFirst) return dominant(this.strike.keys) ?? this.strike.last?.midi;
    const all = new Map(this.strike.keys);
    for (const [k, v] of this.strike.jumpVotes) all.set(k, (all.get(k) ?? 0) + v);
    return dominant(all) ?? this.strike.last?.midi;
  }

  /** Une fenêtre d'analyse : résultat guidé (autour de la séquence) et éventuellement résultat libre. */
  observe(guided: Scored, free: Scored): Attribution | null {
    const s = this.strike;
    let att: Attribution | null = null;

    if (this.cur === undefined) {
      if (!ok(free)) return null;
      att = this.make(this.nearest(free.fit.f0), free.fit, 'libre', false);
    } else if (this.locked) {
      if (!ok(guided)) return null;
      att = this.make(this.cur, guided.fit, 'cadenas', false);
    } else if (this.cfg.freeFirst) {
      att = this.observeFreeFirst(guided, free);
    } else {
      let g = ok(guided) ? this.attribute(guided.fit) : null;
      if (ok(free)) {
        const m = this.nearest(free.fit.f0);
        const outside = Math.abs(m - this.cur) > 2;
        const better = !ok(guided) || !g || free.score > this.cfg.jumpScoreRatio * guided.score;
        if (outside && better) {
          // indice de grand saut : la détection libre trouve une note hors de la fenêtre de séquence, nettement mieux expliquée
          s.jumpVotes.set(m, (s.jumpVotes.get(m) ?? 0) + 1);
          // lecture libre affichée seulement si la séquence n'a encore rien reconnu sur cette frappe
          if (!g && !s.keys.size) att = this.make(m, free.fit, 'libre', !this.jumpWouldConfirm(m), 'saut');
        } else if (!outside && better && (!g || m !== g.midi)) {
          // dans la fenêtre de séquence, la détection libre explique mieux le spectre : on la préfère
          g = this.attribute(free.fit);
        }
      }
      if (g) att = g;
    }
    if (att) {
      s.last = att; s.frames++; s.lastOf.set(att.midi, att);
      if (att.source !== 'libre') s.keys.set(att.midi, (s.keys.get(att.midi) ?? 0) + 1);
      else if (this.cfg.freeFirst) s.jumpVotes.set(att.midi, (s.jumpVotes.get(att.midi) ?? 0) + 1);
    }
    return att;
  }

  /** Une frappe suffit : la détection libre décide, la séquence ne départage que les hésitations d'octave. */
  private observeFreeFirst(guided: Scored, free: Scored): Attribution | null {
    const g = ok(guided) ? this.attribute(guided.fit) : null;
    if (!ok(free)) return g;
    const m = this.nearest(free.fit.f0);
    if (!g) return Math.abs(m - this.cur!) <= 2 ? this.attribute(free.fit) ?? this.make(m, free.fit, 'libre', false) : this.make(m, free.fit, 'libre', false, 'saut');
    const d = Math.abs(m - g.midi);
    if (d <= 2) {
      // même zone : la détection libre explique mieux le spectre → on la préfère, avec les règles de séquence
      return ok(guided) && free.score > this.cfg.jumpScoreRatio * guided.score && m !== g.midi ? this.attribute(free.fit) ?? g : g;
    }
    const octaveLike = d === 12 || d === 19 || d === 24 || d === 7 || d === 28 || d === 31;
    const ratio = octaveLike ? this.cfg.jumpScoreRatio : 0.8;
    return ok(guided) && free.score > ratio * guided.score ? this.make(m, free.fit, 'libre', false, 'saut') : g;
  }

  /** Fin de frappe (mesure figée) : met à jour la note courante, le sens, les sauts en attente. */
  commit(final?: { f0: number; B: number }): StrikeCommit | null {
    const s = this.strike;
    this.strike = newStrike();
    if (!s.last) return null;
    // la frappe est attribuée à la touche la plus souvent reconnue par la séquence ; à défaut, lecture libre
    const seqKey = dominant(s.keys);
    let last = s.last;
    if (seqKey !== undefined && (last.source === 'libre' || last.midi !== seqKey)) last = s.lastOf.get(seqKey) ?? last;
    const f0 = final?.f0 ?? last.fit.f0, B = final?.B ?? last.fit.B;

    // vote de saut majoritaire sur la frappe
    let jump: number | undefined, best = 0;
    for (const [m, v] of s.jumpVotes) if (v > best) { best = v; jump = m; }
    const jumpMajority = jump !== undefined && best * 2 >= s.frames;

    let key = last.midi, correction = last.correction, tentative = false;
    if (this.cfg.freeFirst && !this.locked) {
      // touche la plus souvent attribuée sur la frappe, toutes sources confondues
      const all = new Map<number, number>();
      for (const [k, v] of s.keys) all.set(k, v);
      for (const [k, v] of s.jumpVotes) all.set(k, (all.get(k) ?? 0) + v);
      const k = dominant(all);
      if (k !== undefined && k !== key) { last = s.lastOf.get(k) ?? last; key = k; correction = last.correction; }
      if (this.cur !== undefined && key !== this.cur && Math.abs(key - this.cur) === 1) this.dir = key > this.cur ? 1 : -1;
      this.cur = key; this.pending = null;
      const f0b = final?.f0 ?? last.fit.f0, Bb = final?.B ?? last.fit.B;
      const c = centsBetween(f0b, midiToFreq(key, this.la4));
      this.readings.set(key, { f0: f0b, cents: c });
      return { midi: key, name: noteName(key), cents: c, f0: f0b, B: Bb, current: key, correction, tentative: false };
    }
    if (this.cur === undefined) {
      this.cur = key;
    } else if (!this.locked && jumpMajority && jump !== undefined) {
      const count = this.pending && this.pending.midi === jump ? this.pending.count + 1 : 1;
      const needed = this.needed(jump);
      if (count >= needed) {
        this.cur = jump; this.pending = null; key = jump; correction = 'saut';
      } else {
        this.pending = { midi: jump, count };
        tentative = last.source === 'libre';
      }
      if (last.source === 'libre') key = jump;
    } else {
      this.pending = null;
      if (key !== this.cur) {
        if (Math.abs(key - this.cur) === 1) this.dir = key > this.cur ? 1 : -1;
        this.cur = key;
      }
    }
    const cents = centsBetween(f0, midiToFreq(key, this.la4));
    if (!tentative) this.readings.set(key, { f0, cents });
    const p = this.pending;
    return {
      midi: key, name: noteName(key), cents, f0, B, current: this.cur, correction, tentative,
      pendingJump: p ? { midi: p.midi, count: p.count, needed: this.needed(p.midi) } : undefined,
    };
  }

  // ---------------------------------------------------------------------------------------------

  private needed(m: number): number {
    if (this.cur === undefined) return 1;
    const d = Math.abs(m - this.cur);
    return d === 12 || d === 19 || d === 24 || d === 28 || d === 31 ? this.cfg.octaveJumpStrikes : this.cfg.jumpStrikes;
  }

  private jumpWouldConfirm(m: number): boolean {
    return !!this.pending && this.pending.midi === m && this.pending.count + 1 >= this.needed(m);
  }

  private nearest(f0: number): number { return clampKey(Math.round(69 + 12 * Math.log2(f0 / this.la4))); }

  private make(midi: number, fit: FitResult, source: Attribution['source'], tentative: boolean, correction?: Correction): Attribution {
    return { midi, name: noteName(midi), cents: centsBetween(fit.f0, midiToFreq(midi, this.la4)), fit, tentative, correction, source };
  }

  /** Attribution guidée par la séquence (voir l'en-tête du fichier). */
  private attribute(fit: FitResult): Attribution | null {
    const c = this.cur!, f0 = fit.f0;
    let k = this.nearest(f0), correction: Correction | undefined;
    if (Math.abs(k - c) > 2) return null;
    const prev = this.readings.get(c);
    if (prev) {
      const fromPrev = centsBetween(f0, prev.f0);
      const tuned = Math.abs(prev.cents) <= this.cfg.tunedCents;
      if (k === c && tuned && fromPrev * this.dir > this.cfg.slideCents) {
        k = c + this.dir; correction = 'glissement';
      } else if (k !== c && Math.abs(k - c) === 1 && !tuned && Math.abs(fromPrev) < this.cfg.continuityCents) {
        k = c; correction = 'continuite';
      }
    }
    return this.make(clampKey(k), fit, 'sequence', false, correction);
  }
}

function newStrike() {
  return { last: undefined as Attribution | undefined, lastOf: new Map<number, Attribution>(), keys: new Map<number, number>(), jumpVotes: new Map<number, number>(), frames: 0 };
}
function dominant(m: Map<number, number>): number | undefined {
  let k: number | undefined, best = 0;
  for (const [key, v] of m) if (v > best) { best = v; k = key; }
  return k;
}

const clampKey = (m: number) => Math.min(LAST_KEY, Math.max(FIRST_KEY, m));
