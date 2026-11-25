/** Fiche du piano d'une séance + relevé optionnel de l'accordeur habituel + tests d'octave. */

export interface FichePiano {
  marque: string;
  modele: string;
  type: 'droit' | 'queue' | '';
  /** Hauteur (droit) ou longueur (queue), en cm */
  tailleCm?: number;
  serie: string;
  /** Laisser vide : déduite du numéro de série à l'analyse */
  annee?: number;
}

export interface FicheSeance {
  piano: FichePiano;
  /** La4 visé (Hz) */
  la4: number;
  /** Accordeur suivi pendant la séance : son réglage de référence */
  accordeurUtilise: 'PTA-1' | 'Accordeur Pro' | 'oreille' | 'autre';
  /** Réglage d'étirement / courbe de l'accordeur habituel, en clair */
  reglageAccordeur: string;
  /** Écart moyen avant l'accord (cents, approximatif) */
  ecartAvantCents?: number;
  position: 'pupitre' | 'cadre' | 'table' | 'sol' | 'autre' | '';
  temperature?: number;
  humidite?: number;
  remarques: string;
  /** Lecture de l'accordeur habituel à la fin, note par note (n° de touche 1–88 → cents). Optionnel. */
  releve: Record<number, number>;
}

export const MODELES_YAMAHA = [
  // droits
  'b1', 'b2', 'b3', 'P116', 'P121', 'LU-101', 'LU-201', 'MC10', 'MC301', 'U1', 'U2', 'U3', 'UX', 'UX3', 'MX100', 'YUS1', 'YUS3', 'YUS5', 'SE122', 'SU7',
  // queues
  'GB1', 'GC1', 'GC2', 'G1', 'G2', 'G3', 'G5', 'G7', 'C1', 'C2', 'C3', 'C5', 'C6', 'C7', 'C1X', 'C2X', 'C3X', 'C5X', 'C6X', 'C7X', 'S3X', 'S6X', 'CF4', 'CFIIIS', 'CFX',
];

/** Type deviné d'après le modèle (les queues Yamaha commencent par G, C, S ou CF) */
export function typeDuModele(m: string): FichePiano['type'] {
  const s = m.trim().toUpperCase(); if (!s) return '';
  return /^(G|C|S\d|CF)/.test(s) ? 'queue' : 'droit';
}

export function ficheVide(la4 = 440): FicheSeance {
  return {
    piano: { marque: 'Yamaha', modele: '', type: '', serie: '' },
    la4, accordeurUtilise: 'PTA-1', reglageAccordeur: '', position: 'pupitre', remarques: '', releve: {},
  };
}

/** Champs manquants qui comptent pour l'analyse (le reste est facultatif) */
export function manques(f: FicheSeance): string[] {
  const m: string[] = [];
  if (!f.piano.modele.trim()) m.push('modèle');
  if (!f.piano.serie.trim() && !f.piano.annee) m.push('n° de série ou année');
  if (!f.piano.tailleCm && !f.piano.modele.trim()) m.push('taille');
  return m;
}

/** Nom de fichier : 2026-11-25_1432_Yamaha-U3_5123456 */
export function nomFichier(debut: Date, f: FicheSeance): string {
  const p = (v: number) => String(v).padStart(2, '0');
  const d = `${debut.getFullYear()}-${p(debut.getMonth() + 1)}-${p(debut.getDate())}_${p(debut.getHours())}${p(debut.getMinutes())}`;
  const clean = (s: string) => s.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return [d, [clean(f.piano.marque), clean(f.piano.modele)].filter(Boolean).join('-'), clean(f.piano.serie)].filter(Boolean).join('_');
}

// ---- pianos déjà vus (visites suivantes : une touche pour remplir la fiche) ----
const CLE = 'accordeur-pro.pianos';
export function pianosConnus(): FichePiano[] {
  try { return JSON.parse(localStorage.getItem(CLE) ?? '[]') as FichePiano[]; } catch { return []; }
}
export function memoriserPiano(p: FichePiano): void {
  if (!p.serie.trim() && !p.modele.trim()) return;
  try {
    const l = pianosConnus().filter(x => !(x.serie && x.serie === p.serie));
    l.unshift(p); localStorage.setItem(CLE, JSON.stringify(l.slice(0, 300)));
  } catch { /* stockage indisponible */ }
}
