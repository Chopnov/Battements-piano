import type { FitRejection, FitResult, PartialMatch, SpectralPeak } from './types';

/** Fletcher : f_k = k f0 sqrt(1 + B k²) */
export function partialFreq(f0: number, B: number, k: number): number {
  return k * f0 * Math.sqrt(1 + B * k * k);
}

const C = 1200 / Math.LN2;
export const centsBetween = (a: number, b: number): number => C * Math.log(a / b);
export const midiToFreq = (midi: number, la4 = 440): number => la4 * Math.pow(2, (midi - 69) / 12);

/**
 * Poids par rang de partiel.
 * Graves : k=3..6 dominent, le pic k=1 est ignoré (souvent inaudible, jamais requis).
 * Médiums/aigus : k=1..3 dominent. Transition progressive entre A2 (110 Hz) et C4 (262 Hz).
 */
const W_BASS = [0, 0.35, 1, 1, 1, 1, 0.5, 0.5, 0.25, 0.25];
const W_TREBLE = [1, 1, 1, 0.5, 0.5, 0.25, 0.25, 0.15, 0.1, 0.1];
export function regionWeight(k: number, f0: number): number {
  const t = Math.min(1, Math.max(0, Math.log2(f0 / 110) / Math.log2(262 / 110)));
  const i = Math.min(k, 10) - 1;
  return (1 - t) * W_BASS[i] + t * W_TREBLE[i];
}

export interface FitOptions {
  /** Note MIDI visée (l'accordeur sait quelle touche il joue). Sans elle, recherche sur toute la tessiture. */
  midiHint?: number;
  la4?: number;
  /** Fenêtre de recherche autour de la note visée (cents) */
  searchCents?: number;
  kMin?: number;
  kMax?: number;
  minPartials?: number;
  maxRmsCents?: number;
  minCoherence?: number;
  fMaxAnalysis?: number;
  fMinAnalysis?: number;
}

const DEF = {
  la4: 440, searchCents: 120, kMin: 1, kMax: 10, minPartials: 3,
  maxRmsCents: 4, minCoherence: 0.5, fMaxAnalysis: 12000, fMinAnalysis: 20,
};

interface Prep { peaks: SpectralPeak[] }

/** Pic le plus fort (rapport signal/bruit) dans ±tol cents autour de f. */
function bestPeak(p: Prep, f: number, tolCents: number): SpectralPeak | null {
  const lo = f * Math.pow(2, -tolCents / 1200), hi = f * Math.pow(2, tolCents / 1200);
  const a = p.peaks;
  let l = 0, h = a.length;
  while (l < h) { const m = (l + h) >> 1; if (a[m].freq < lo) l = m + 1; else h = m; }
  let best: SpectralPeak | null = null;
  for (let i = l; i < a.length && a[i].freq <= hi; i++) if (!best || a[i].snrDb > best.snrDb) best = a[i];
  return best;
}

interface Obs { k: number; freq: number; snr: number; mag: number }

/**
 * Régression pondérée de Fletcher, dans le domaine des cents :
 * minimise Σ w_k e_k², e_k = 1200 log2( f_k / (k f0 sqrt(1 + B k²)) ), inconnues (ln f0, B).
 * Gauss-Newton à 2 paramètres, initialisé par la droite (f_k/k)² = f0² (1 + B k²).
 * Si fixedB est fourni, seul f0 est résolu (utile avec 1 ou 2 partiels).
 */
export function fitFletcher(
  obs: Obs[], weightOf: (o: Obs) => number, fixedB?: number,
): { f0: number; B: number; sigmaF0Cents: number; sigmaB: number; rms: number } | null {
  const n = obs.length;
  if (n < 1 || (fixedB === undefined && n < 2)) return null;
  const w = obs.map(weightOf);
  const sw = w.reduce((a, b) => a + b, 0);
  if (!(sw > 0)) return null;

  let B = fixedB ?? 0, lnF0 = 0;
  if (fixedB === undefined) {
    // droite pondérée y = a + b x, x = k², y = (f/k)²
    let s = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    obs.forEach((o, i) => {
      const x = o.k * o.k, y = (o.freq / o.k) ** 2;
      s += w[i]; sx += w[i] * x; sy += w[i] * y; sxx += w[i] * x * x; sxy += w[i] * x * y;
    });
    const det = s * sxx - sx * sx;
    if (Math.abs(det) > 1e-12 * s * sxx) {
      const b = (s * sxy - sx * sy) / det, a = (sy - b * sx) / s;
      if (a > 0) { lnF0 = 0.5 * Math.log(a); B = Math.max(0, b / a); }
    }
  }
  if (lnF0 === 0) lnF0 = Math.log(obs.reduce((acc, o, i) => acc + w[i] * o.freq / o.k, 0) / sw);

  const iters = fixedB === undefined ? 8 : 3;
  let last: { JtWJ: number[][]; rss: number } | null = null;
  for (let it = 0; it < iters; it++) {
    let a11 = 0, a12 = 0, a22 = 0, g1 = 0, g2 = 0, rss = 0;
    for (let i = 0; i < n; i++) {
      const o = obs[i], q = 1 + B * o.k * o.k;
      const e = C * (Math.log(o.freq) - Math.log(o.k) - lnF0 - 0.5 * Math.log(q));
      const d1 = -C, d2 = -C * 0.5 * o.k * o.k / q;
      a11 += w[i] * d1 * d1; a12 += w[i] * d1 * d2; a22 += w[i] * d2 * d2;
      g1 += w[i] * d1 * e; g2 += w[i] * d2 * e; rss += w[i] * e * e;
    }
    last = { JtWJ: [[a11, a12], [a12, a22]], rss };
    if (fixedB !== undefined) { lnF0 -= g1 / a11; continue; }
    const det = a11 * a22 - a12 * a12;
    if (!(Math.abs(det) > 1e-18)) break;
    lnF0 -= (a22 * g1 - a12 * g2) / det;
    B = Math.max(0, B - (-a12 * g1 + a11 * g2) / det);
  }
  // recalcul des résidus finaux
  let rss = 0;
  obs.forEach((o, i) => {
    const e = C * (Math.log(o.freq) - Math.log(o.k) - lnF0 - 0.5 * Math.log(1 + B * o.k * o.k));
    rss += w[i] * e * e;
  });
  const dof = Math.max(1, n - (fixedB === undefined ? 2 : 1));
  const s2 = rss / sw * (n / dof); // variance pondérée corrigée des degrés de liberté
  let sigmaF0 = Math.sqrt(s2 / Math.max(1e-12, sw)) * 1, sigmaB = 0;
  if (last && fixedB === undefined) {
    const [[a11, a12], [, a22]] = last.JtWJ, det = a11 * a22 - a12 * a12;
    if (det > 1e-18) {
      // JtWJ calculé avec les poids bruts : cov = s2 * (JtWJ / sw)^-1 / sw... on normalise par sw
      const scale = s2 * sw; // (σ² normalisé) × Σw
      sigmaF0 = Math.sqrt(Math.max(0, scale * a22 / det));
      sigmaB = Math.sqrt(Math.max(0, scale * a11 / det)) / C;
    }
  } else if (last) sigmaF0 = Math.sqrt(s2 * sw / last.JtWJ[0][0]);
  return { f0: Math.exp(lnF0), B, sigmaF0Cents: sigmaF0, sigmaB, rms: Math.sqrt(rss / sw) };
}

/**
 * Recherche grossière de (f0, B) par peigne inharmonique, sans exiger le pic k=1 dans les graves.
 * Renvoie plusieurs candidats (maxima locaux du score) : f0, f0/2 et 2f0 expliquent tous une partie des pics,
 * le choix se fait après ajustement complet.
 */
function coarseCandidates(p: Prep, lo: number, hi: number, stepCents: number, kLo: number, max = 5): { f0: number; B: number; score: number }[] {
  const Bgrid = [5e-5, 1.5e-4, 4e-4, 1e-3, 2.5e-3, 6e-3, 1.2e-2, 2.5e-2, 5e-2];
  const nSteps = Math.floor(centsBetween(hi, lo) / stepCents);
  const cells: { f0: number; B: number; score: number }[] = [];
  for (let s = 0; s <= nSteps; s++) {
    const f0 = lo * Math.pow(2, (s * stepCents) / 1200);
    const kStart = f0 > 150 ? kLo : Math.max(2, kLo);
    let best = { f0, B: Bgrid[0], score: -Infinity };
    for (const B of Bgrid) {
      let score = 0;
      for (let k = kStart; k <= 6; k++) {
        const fk = partialFreq(f0, B, k);
        if (fk > DEF.fMaxAnalysis) break;
        const pk = bestPeak(p, fk, 30);
        score += (regionWeight(k, f0) + 0.15) * ((pk ? Math.min(1, pk.snrDb / 30) : 0) - 0.3);
      }
      if (score > best.score) best = { f0, B, score };
    }
    cells.push(best);
  }
  const span = Math.max(1, Math.round(150 / stepCents));
  const peaks = cells.filter((c, i) => {
    if (!(c.score > 0)) return false;
    for (let j = Math.max(0, i - span); j <= Math.min(cells.length - 1, i + span); j++) if (cells[j].score > c.score || (cells[j].score === c.score && j < i)) return false;
    return true;
  });
  return peaks.sort((x, y) => y.score - x.score).slice(0, max);
}

/**
 * Estime la fondamentale virtuelle f0 et l'inharmonicité B à partir des pics d'un spectre.
 * Retourne un rejet explicite si les pics ne forment pas une série de partiels cohérente
 * (bruit blanc, voix, ventilation...).
 */
export function fitInharmonicity(peaks: SpectralPeak[], opts: FitOptions = {}): FitResult | FitRejection {
  const r = fitInharmonicityScored(peaks, opts);
  return 'rejected' in r ? r : r.fit;
}

/**
 * Comme fitInharmonicity, mais renvoie aussi le score de vraisemblance de la série retenue
 * (cohérence × part des rangs k attendus effectivement trouvés, 0..1). Sert au suivi de séquence
 * pour comparer « note attendue » et « détection libre ».
 */
export function fitInharmonicityScored(peaks: SpectralPeak[], opts: FitOptions = {}): { fit: FitResult; score: number } | FitRejection {
  const o = { ...DEF, ...opts };
  if (peaks.length < 2) return { rejected: 'no-peaks' };
  const p: Prep = { peaks: [...peaks].sort((a, b) => a.freq - b.freq) };

  let lo: number, hi: number, step: number;
  if (o.midiHint !== undefined) {
    const nom = midiToFreq(o.midiHint, o.la4);
    lo = nom * Math.pow(2, -o.searchCents / 1200); hi = nom * Math.pow(2, o.searchCents / 1200); step = 2;
  } else { lo = 25; hi = 4400; step = 6; }
  const cands = coarseCandidates(p, lo, hi, step, o.kMin);
  if (!cands.length) return { rejected: 'low-coherence' };

  // Chaque candidat est ajusté complètement ; on garde celui dont la série explique le mieux le spectre
  // (cohérence × part des rangs k attendus effectivement trouvés), ce qui écarte f0/2 et 2f0.
  let best: { fit: FitResult; score: number } | null = null, lastReject: FitRejection = { rejected: 'low-coherence' };
  for (const c of cands) {
    const r = fitFromCandidate(p, peaks, c, o);
    if ('rejected' in r) { lastReject = r; continue; }
    const score = r.fit.coherence * r.found / Math.max(1, r.expected);
    if (!best || score > best.score) best = { fit: r.fit, score };
  }
  return best ?? lastReject;
}

type Opts = typeof DEF & FitOptions;

function fitFromCandidate(p: Prep, peaks: SpectralPeak[], c: { f0: number; B: number }, o: Opts):
  { fit: FitResult; found: number; expected: number } | FitRejection {
  // Extension progressive : on prédit le partiel k+1 avec le modèle courant, on cherche un pic, on réajuste.
  let model = { f0: c.f0, B: c.B };
  const obs: Obs[] = [];
  const wOf = (ob: Obs) => regionWeight(ob.k, model.f0) * (0.15 + 0.85 * Math.min(1, Math.max(0, (ob.snr - 8) / 32)));
  const kStart = model.f0 > 150 ? o.kMin : Math.max(2, o.kMin);
  for (let k = kStart; k <= o.kMax; k++) {
    const fk = partialFreq(model.f0, model.B, k);
    if (fk > o.fMaxAnalysis) break;
    const tol = obs.length < 3 ? 30 : 18;
    const pk = bestPeak(p, fk, tol);
    if (!pk) continue;
    obs.push({ k, freq: pk.freq, snr: pk.snrDb, mag: pk.magDb });
    const f = fitFletcher(obs, wOf, obs.length < 3 ? model.B : undefined);
    if (f) model = { f0: f.f0, B: f.B };
  }
  if (obs.length < o.minPartials) return { rejected: 'too-few-partials' };

  // Réajustement final avec rejet itératif des aberrants (écart > max(2,5 σ robuste) cents)
  let used = obs.slice(), fit = fitFletcher(used, wOf);
  while (fit && used.length > o.minPartials) {
    const res = used.map(u => centsBetween(u.freq, partialFreq(fit!.f0, fit!.B, u.k)));
    const sorted = res.map(Math.abs).sort((a, b) => a - b);
    const mad = sorted[Math.floor(sorted.length / 2)] * 1.4826;
    const thr = Math.max(2, 5 * mad);
    let worst = -1, wv = 0;
    res.forEach((r, i) => { if (Math.abs(r) > thr && Math.abs(r) > wv) { wv = Math.abs(r); worst = i; } });
    if (worst < 0) break;
    used.splice(worst, 1);
    fit = fitFletcher(used, wOf);
  }
  if (!fit) return { rejected: 'poor-fit' };
  if (used.length < o.minPartials) return { rejected: 'too-few-partials' };
  if (o.midiHint !== undefined) {
    const dev = Math.abs(centsBetween(fit.f0, midiToFreq(o.midiHint, o.la4)));
    if (dev > o.searchCents * 1.5) return { rejected: 'f0-out-of-range' };
  }
  const partials: PartialMatch[] = used.map(u => ({
    k: u.k, freq: u.freq, snrDb: u.snr, magDb: u.mag,
    residualCents: centsBetween(u.freq, partialFreq(fit!.f0, fit!.B, u.k)),
    weight: wOf(u),
  }));
  const rms = Math.sqrt(partials.reduce((a, q) => a + q.residualCents ** 2, 0) / partials.length);
  if (rms > o.maxRmsCents) return { rejected: 'poor-fit' };

  // Filtre de cohérence harmonique : part de l'énergie des pics significatifs expliquée par la série f_k.
  const maxMag = Math.max(...peaks.map(q => q.magDb));
  const signif = peaks.filter(q => q.magDb >= maxMag - 30 && q.snrDb >= 12 && q.freq >= o.fMinAnalysis && q.freq <= o.fMaxAnalysis);
  let eAll = 0, eOk = 0;
  for (const q of signif) {
    const e = Math.pow(10, q.magDb / 10);
    eAll += e;
    for (let k = 1; k <= 40; k++) {
      const fk = partialFreq(fit.f0, fit.B, k);
      if (fk > q.freq * 1.2) break;
      if (Math.abs(centsBetween(q.freq, fk)) < 12) { eOk += e; break; }
    }
  }
  const coherence = eAll > 0 ? eOk / eAll : 0;
  if (coherence < o.minCoherence) return { rejected: 'low-coherence' };

  let expected = 0;
  for (let k = kStart; k <= o.kMax; k++) if (partialFreq(fit.f0, fit.B, k) <= o.fMaxAnalysis) expected++;
  return {
    fit: {
      f0: fit.f0, B: fit.B, sigmaF0Cents: fit.sigmaF0Cents, sigmaB: fit.sigmaB,
      partials, rmsCents: rms, coherence,
      fundamentalUsed: used.some(u => u.k === 1),
    },
    found: used.length, expected,
  };
}


export const isRejection = (r: FitResult | FitRejection): r is FitRejection => 'rejected' in r;
