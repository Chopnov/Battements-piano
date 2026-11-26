import { SpectrumAnalyzer, type Spectrum } from './spectrum';
import { fitInharmonicity, fitInharmonicityScored, isRejection, centsBetween, midiToFreq, type FitOptions } from './inharmonicityEngine';
import type { NoteTracker, StrikePlan } from './noteTracker';
import { noteName } from './tuningCurve';
import type { DetectedNote, FrameRejection, FusedMeasurement, ProcessorEvent, ProcessorState } from './types';

export interface ProcessorConfig {
  sampleRate: number;
  /** Taille de la fenêtre d'analyse (16384 à 48 kHz = 341 ms) */
  frameSize: number;
  /** Pas entre deux analyses (échantillons) */
  hop: number;
  zeroPad: number;
  /** Durée ignorée après le début de l'attaque (marteau) */
  transientMs: number;
  /** Seuil de détection d'attaque au-dessus du plancher de bruit (rapport d'amplitude) */
  onsetRatio: number;
  /** Seuil de maintien : en dessous, le signal est considéré comme retombé (hystérésis) */
  offRatio: number;
  minSnrDb: number;
  fMinAnalysis: number;
  fMaxAnalysis: number;
  /**
   * Avec un suivi de note : fenêtre adaptée au registre de la note attendue
   * (16384 graves, 8192 médium, 4096 aigus à 48 kHz ; pas = fenêtre / 8).
   */
  adaptiveWindow: boolean;
}

/** Taille de fenêtre selon la note attendue (à 48 kHz ; proportionnelle à la fréquence d'échantillonnage). */
export function windowForMidi(midi: number | undefined): number {
  return midi === undefined || midi < 45 ? 16384 : midi < 64 ? 8192 : 4096;
}

export const DEFAULT_CONFIG: ProcessorConfig = {
  sampleRate: 48000, frameSize: 16384, hop: 4096, zeroPad: 4,
  transientMs: 40, onsetRatio: 4, offRatio: 2, minSnrDb: 10,
  fMinAnalysis: 20, fMaxAnalysis: 12000, adaptiveWindow: true,
};

const BLOCK_MS = 5;

/**
 * Chaîne de traitement : flux d'échantillons -> enveloppe RMS (blocs de 5 ms) -> détection
 * d'attaque / plancher de bruit dynamique -> fenêtres de 16384 échantillons (Blackman-Harris,
 * zero-padding, pics paraboliques) -> ajustement de Fletcher -> cohérence harmonique ->
 * fusion des fenêtres, mesure figée quand le signal retombe.
 *
 * Indépendant du navigateur : le worklet ne fait que transmettre les échantillons (testable hors ligne).
 */
export class AudioProcessor {
  readonly cfg: ProcessorConfig;
  private analyzers = new Map<number, SpectrumAnalyzer>();
  private size: number;
  private hop: number;
  private tracker: NoteTracker | undefined;
  private plan: StrikePlan | undefined;
  private freeMisses = 0;
  private freeRuns = 0;
  private lastNote: DetectedNote | undefined;
  private ring: Float32Array;
  private total = 0;                 // échantillons reçus au total
  private lastFrameEnd = 0;
  private lastNoiseRef = 0;
  private blockSize: number;
  private blockAcc = 0; private blockN = 0;
  private blockStart = 0;
  private blockRms: { start: number; rms: number }[] = [];
  private state: ProcessorState = 'silent';
  private floor = 0; private floorInit = 0; private floorBlocks = 0;
  private onsetSample = -1;
  private belowCount = 0;
  private prevRms: number[] = [];
  private noiseRefs = new Map<number, Float64Array>();
  private frames: { f0c: number; B: number; sigma: number; fund: boolean; f0: number; key?: number }[] = [];
  private fusedFinal: FusedMeasurement | undefined;
  private fitOpts: FitOptions = {};

  constructor(cfg: Partial<ProcessorConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.size = this.cfg.frameSize; this.hop = this.cfg.hop;
    this.ring = new Float32Array(Math.max(this.cfg.frameSize, 16384) * 2);
    this.blockSize = Math.round((BLOCK_MS / 1000) * this.cfg.sampleRate);
  }

  /** Note visée et diapason (l'accordeur sait quelle touche il joue). */
  setTarget(midi: number | undefined, la4 = 440): void { this.fitOpts = { midiHint: midi, la4 }; this.la4 = la4; this.tracker?.setLa4(la4); }
  private la4 = 440;

  /**
   * Branche le suivi de séquence (détection intelligente). Sans suivi : comportement de l'étape 1
   * (touche visée par setTarget, ou détection libre).
   */
  setTracker(t: NoteTracker | undefined): void { this.tracker = t; t?.setLa4(this.la4); }
  get noteTracker(): NoteTracker | undefined { return this.tracker; }
  /** Nombre total d'échantillons reçus (horloge commune avec l'enregistreur) */
  get samplesSeen(): number { return this.total; }
  /** Taille de la fenêtre d'analyse en cours */
  get windowSize(): number { return this.size; }

  private analyzer(n: number): SpectrumAnalyzer {
    let a = this.analyzers.get(n);
    if (!a) { a = new SpectrumAnalyzer(this.cfg.sampleRate, n, this.cfg.zeroPad, this.cfg.fMaxAnalysis); this.analyzers.set(n, a); }
    return a;
  }

  /** Choisit la fenêtre selon le plan du suivi (au début de chaque frappe et pendant les silences). */
  private applyPlan(): void {
    if (!this.tracker) return;
    this.plan = this.tracker.plan();
    if (!this.cfg.adaptiveWindow) return;
    this.size = windowForMidi(this.plan.windowMidi);
    this.hop = Math.round(this.size / 12);
  }

  /** Touche la plus proche de f0 (tempérament égal) et écart en cents. */
  identify(f0: number): DetectedNote {
    const midi = Math.round(69 + 12 * Math.log2(f0 / this.la4));
    return { midi, name: noteName(midi), cents: centsBetween(f0, this.la4 * Math.pow(2, (midi - 69) / 12)) };
  }

  reset(): void {
    this.state = 'silent'; this.frames = []; this.fusedFinal = undefined; this.onsetSample = -1; this.belowCount = 0;
  }

  get currentState(): ProcessorState { return this.state; }

  /** Pousse des échantillons mono ; renvoie un événement par bloc de 5 ms ayant changé quelque chose d'utile. */
  push(chunk: Float32Array): ProcessorEvent[] {
    const out: ProcessorEvent[] = [];
    const L = this.ring.length;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      this.ring[this.total % L] = v;
      if (this.blockN === 0) this.blockStart = this.total;
      this.blockAcc += v * v; this.blockN++;
      this.total++;
      if (this.blockN === this.blockSize) {
        const ev = this.onBlock(Math.sqrt(this.blockAcc / this.blockN));
        this.blockAcc = 0; this.blockN = 0;
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  private onBlock(rms: number): ProcessorEvent | null {
    const { cfg } = this;
    this.blockRms.push({ start: this.blockStart, rms });
    const keep = Math.ceil((Math.max(cfg.frameSize, this.size) * 1.5) / this.blockSize);
    if (this.blockRms.length > keep) this.blockRms.shift();

    // --- plancher de bruit initial : minimum sur les 0,5 premières secondes ---
    if (this.floorBlocks < 100) {
      this.floorInit = this.floorBlocks === 0 ? rms : Math.min(this.floorInit, rms);
      this.floorBlocks++;
      this.floor = Math.max(this.floorInit, 1e-6);
      this.prevRms.push(rms); if (this.prevRms.length > 4) this.prevRms.shift();
      return null;
    }
    const prevMean = this.prevRms.length ? this.prevRms.reduce((a, b) => a + b, 0) / this.prevRms.length : rms;
    const onThr = Math.max(this.floor * cfg.onsetRatio, 3e-4);
    const offThr = Math.max(this.floor * cfg.offRatio, 1.5e-4);

    let rejected: FrameRejection | undefined;
    let frozenNow = false;
    let committed: ProcessorEvent['committed'];

    if (this.state === 'silent' || this.state === 'frozen') {
      // le plancher suit le minimum : descend vite, remonte lentement (~25 s)
      if (rms < this.floor) this.floor = Math.max(rms, 1e-6); else if (rms < onThr) this.floor += (rms - this.floor) * 0.0002;
      if (rms > onThr && rms > 1.8 * prevMean) {
        this.state = 'attack';
        // l'attaque a pu commencer dans le bloc précédent
        this.onsetSample = this.blockStart - this.blockSize;
        this.frames = []; this.fusedFinal = undefined; this.belowCount = 0;
        this.startStrike();
      }
    } else {
      if (rms < offThr) this.belowCount++; else this.belowCount = 0;
      if (this.belowCount >= 3) {
        this.state = 'frozen'; frozenNow = true;
        this.fusedFinal = this.fuse();
        committed = this.endStrike(this.fusedFinal);
      } else if (rms > onThr && rms > 3 * prevMean) {
        // nouvelle frappe : on clôt la précédente et on repart de zéro
        committed = this.endStrike(this.fuse());
        this.onsetSample = this.blockStart - this.blockSize; this.frames = []; this.state = 'attack'; rejected = 'retrigger';
        this.startStrike();
      } else if (this.state === 'attack' && this.blockStart >= this.onsetSample + (cfg.transientMs / 1000) * cfg.sampleRate) {
        this.state = 'sustain';
      }
    }
    this.prevRms.push(rms); if (this.prevRms.length > 4) this.prevRms.shift();

    let frame: ProcessorEvent['frame'];
    // --- fenêtre d'analyse à chaque pas ---
    if (this.total >= this.size && this.total - this.lastFrameEnd >= this.hop) {
      this.lastFrameEnd = this.total;
      if (this.state === 'attack' || this.state === 'sustain') {
        const r = this.analyzeFrame(offThr);
        if ('reason' in r) rejected = rejected ?? r.reason; else frame = r.frame;
      } else {
        if (this.tracker) this.applyPlan();
        // plancher spectral de référence, rafraîchi au plus toutes les 100 ms
        if ((this.state === 'silent' || this.tracker) && this.total - this.lastNoiseRef >= 0.1 * cfg.sampleRate) {
          this.lastNoiseRef = this.total; this.updateNoiseRef(offThr);
        }
      }
    }

    return {
      time: this.total / cfg.sampleRate, state: this.state,
      rmsDb: 20 * Math.log10(rms + 1e-9), noiseFloorDb: 20 * Math.log10(this.floor + 1e-9),
      frame, rejected, frozenNow, committed,
      fused: this.state === 'frozen' ? this.fusedFinal : this.fuse(),
    };
  }

  private startStrike(): void {
    if (!this.tracker) return;
    this.tracker.beginStrike(); this.freeRuns = 0; this.freeMisses = 0;
    this.applyPlan();
  }

  private endStrike(fused: FusedMeasurement | undefined): ProcessorEvent['committed'] {
    if (!this.tracker) return undefined;
    return this.tracker.commit(fused ? { f0: fused.f0, B: fused.B } : undefined) ?? undefined;
  }

  private frameSamples(): { data: Float32Array; start: number } {
    const N = this.size, L = this.ring.length, start = this.total - N;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = this.ring[(start + i) % L];
    return { data, start };
  }

  private analyzeFrame(offThr: number): { reason: FrameRejection } | { frame: NonNullable<ProcessorEvent['frame']> } {
    const { cfg } = this;
    const { data, start } = this.frameSamples();
    // 1) transitoire : la fenêtre entière doit commencer après attaque + 40 ms
    if (start < this.onsetSample + (cfg.transientMs / 1000) * cfg.sampleRate) return { reason: 'transient' };
    // 2) la porte doit rester ouverte sur toute la fenêtre
    for (const b of this.blockRms) if (b.start >= start && b.rms < offThr) return { reason: 'gate' };
    // 3) écrêtage
    let pk = 0; for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > pk) pk = a; }
    if (pk >= 0.999) return { reason: 'clipping' };

    const an = this.analyzer(this.size);
    const spec = an.analyze(data);
    const noise = this.noiseDb(spec);
    const peaks = an.pickPeaks(spec, noise, { fMin: cfg.fMinAnalysis, fMax: cfg.fMaxAnalysis, minSnrDb: cfg.minSnrDb });
    if (this.tracker) return this.analyzeTracked(peaks, start);
    const fit = fitInharmonicity(peaks, { ...this.fitOpts, fMinAnalysis: cfg.fMinAnalysis, fMaxAnalysis: cfg.fMaxAnalysis });
    if (isRejection(fit)) return { reason: fit.rejected };
    const sigma = Math.max(0.05, fit.sigmaF0Cents);
    this.frames.push({ f0: fit.f0, f0c: 0, B: fit.B, sigma, fund: fit.fundamentalUsed });
    return { frame: { startSample: start, fit, note: this.identify(fit.f0) } };
  }

  /** Analyse guidée par la séquence + détection libre limitée (premières fenêtres, ou quand la séquence échoue). */
  private analyzeTracked(peaks: ReturnType<SpectrumAnalyzer['pickPeaks']>, start: number): { reason: FrameRejection } | { frame: NonNullable<ProcessorEvent['frame']> } {
    const t = this.tracker!, plan = this.plan ?? t.plan(), cfg = this.cfg;
    const base = { la4: this.la4, fMinAnalysis: cfg.fMinAnalysis, fMaxAnalysis: cfg.fMaxAnalysis };
    // très haut aigu : peu de partiels sous 12 kHz, 2 suffisent quand la note est attendue
    const minFor = (f: number) => (cfg.fMaxAnalysis / f < 5 ? 2 : 3);
    let guided = null as ReturnType<typeof fitInharmonicityScored> | null;
    if (plan.center !== undefined) {
      guided = fitInharmonicityScored(peaks, { ...base, midiHint: plan.center, searchCents: plan.searchCents, minPartials: minFor(midiToFreq(plan.center, this.la4)) });
    }
    let free = null as ReturnType<typeof fitInharmonicityScored> | null;
    if (plan.runFree && (t.cfg.freeFirst || this.freeRuns < 2 || !guided || 'rejected' in guided)) {
      free = fitInharmonicityScored(peaks, base); this.freeRuns++;
    }
    const att = t.observe(guided, free);
    if (!att && t.cfg.freeFirst && cfg.adaptiveWindow && this.size < 16384 && ++this.freeMisses >= 2) {
      // rien de reconnu avec une petite fenêtre : peut-être une note grave après l'aigu → grande fenêtre
      this.size = Math.min(16384, this.size * 2); this.hop = Math.round(this.size / 12); this.freeMisses = 0;
    }
    if (!att) {
      const r = (guided && 'rejected' in guided ? guided : free && 'rejected' in free ? free : { rejected: 'low-coherence' as const });
      return { reason: r.rejected };
    }
    const fit = att.fit;
    // note plus grave que prévu (grand saut vers les basses) : on agrandit la fenêtre pour les fenêtres suivantes
    if (this.cfg.adaptiveWindow && windowForMidi(att.midi) > this.size && windowForMidi(att.midi) <= this.ring.length) {
      this.size = windowForMidi(att.midi); this.hop = Math.round(this.size / 12);
    }
    this.lastNote = { midi: att.midi, name: att.name, cents: att.cents, tentative: att.tentative, correction: att.correction };
    // la touche peut varier en cours de frappe : la fusion ne garde que les fenêtres de la touche dominante (voir fuse)
    this.frames.push({ f0: fit.f0, f0c: 0, B: fit.B, sigma: Math.max(0.05, fit.sigmaF0Cents), fund: fit.fundamentalUsed, key: att.midi });
    return { frame: { startSample: start, fit, note: { midi: att.midi, name: att.name, cents: att.cents, tentative: att.tentative, correction: att.correction } } };
  }

  /** Plancher spectral : bruit local, relevé par le plancher mesuré dans les silences. */
  private noiseDb(spec: Spectrum): Float64Array {
    const local = this.analyzer(this.size).noiseCurve(spec);
    const ref = this.noiseRefs.get(this.size);
    if (!ref || ref.length !== local.length) return local;
    const out = new Float64Array(local.length);
    for (let i = 0; i < local.length; i++) out[i] = Math.max(local[i], ref[i] + 3);
    return out;
  }

  private updateNoiseRef(offThr: number): void {
    for (const b of this.blockRms) if (b.start >= this.total - this.size && b.rms >= offThr) return;
    const { data } = this.frameSamples();
    const an = this.analyzer(this.size);
    const cur = an.noiseCurve(an.analyze(data));
    const ref = this.noiseRefs.get(this.size);
    if (!ref || ref.length !== cur.length) this.noiseRefs.set(this.size, cur);
    else for (let i = 0; i < cur.length; i++) ref[i] = 0.8 * ref[i] + 0.2 * cur[i];
  }

  /** Fusion des fenêtres valides : moyenne pondérée par 1/σ² (f0 en cents), B en log. */
  private fuse(): FusedMeasurement | undefined {
    const key = this.tracker ? this.tracker.strikeKey : undefined;
    const fr = key !== undefined ? this.frames.filter(f => f.key === key) : this.frames;
    if (!fr.length) return undefined;
    const ref = fr[0].f0;
    let sw = 0, sc = 0, sb = 0;
    for (const f of fr) {
      const w = 1 / (f.sigma * f.sigma);
      sw += w; sc += w * centsBetween(f.f0, ref); sb += w * Math.log(Math.max(f.B, 1e-7));
    }
    const f0 = ref * Math.pow(2, sc / sw / 1200);
    const last = this.lastNote;
    const note = key !== undefined
      ? { midi: key, name: noteName(key), cents: centsBetween(f0, midiToFreq(key, this.la4)), tentative: last?.midi === key ? last.tentative : false, correction: last?.midi === key ? last.correction : undefined }
      : this.identify(f0);
    return {
      f0, B: Math.exp(sb / sw), note,
      sigmaF0Cents: Math.sqrt(1 / sw), frames: fr.length, fundamentalUsed: fr.some(f => f.fund),
    };
  }
}
