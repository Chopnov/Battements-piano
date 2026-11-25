import { SpectrumAnalyzer, type Spectrum } from './spectrum';
import { fitInharmonicity, isRejection, centsBetween, type FitOptions } from './inharmonicityEngine';
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
}

export const DEFAULT_CONFIG: ProcessorConfig = {
  sampleRate: 48000, frameSize: 16384, hop: 4096, zeroPad: 4,
  transientMs: 40, onsetRatio: 4, offRatio: 2, minSnrDb: 10,
  fMinAnalysis: 20, fMaxAnalysis: 12000,
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
  private analyzer: SpectrumAnalyzer;
  private ring: Float32Array;
  private total = 0;                 // échantillons reçus au total
  private lastFrameEnd = 0;
  private blockSize: number;
  private blockAcc = 0; private blockN = 0;
  private blockStart = 0;
  private blockRms: { start: number; rms: number }[] = [];
  private state: ProcessorState = 'silent';
  private floor = 0; private floorInit = 0; private floorBlocks = 0;
  private onsetSample = -1;
  private belowCount = 0;
  private prevRms: number[] = [];
  private noiseRef: Float64Array | null = null;
  private frames: { f0c: number; B: number; sigma: number; fund: boolean; f0: number }[] = [];
  private fusedFinal: FusedMeasurement | undefined;
  private fitOpts: FitOptions = {};

  constructor(cfg: Partial<ProcessorConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.analyzer = new SpectrumAnalyzer(this.cfg.sampleRate, this.cfg.frameSize, this.cfg.zeroPad, this.cfg.fMaxAnalysis);
    this.ring = new Float32Array(this.cfg.frameSize * 2);
    this.blockSize = Math.round((BLOCK_MS / 1000) * this.cfg.sampleRate);
  }

  /** Note visée et diapason (l'accordeur sait quelle touche il joue). */
  setTarget(midi: number | undefined, la4 = 440): void { this.fitOpts = { midiHint: midi, la4 }; this.la4 = la4; }
  private la4 = 440;

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
    const keep = Math.ceil((cfg.frameSize * 1.5) / this.blockSize);
    if (this.blockRms.length > keep) this.blockRms.shift();

    // --- plancher de bruit initial : minimum sur les 0,5 premières secondes ---
    if (this.floorBlocks < 100) {
      this.floorInit = this.floorBlocks === 0 ? rms : Math.min(this.floorInit, rms);
      this.floorBlocks++;
      this.floor = Math.max(this.floorInit, 1e-6);
      this.prevRms.push(rms);
      return null;
    }
    const prevMean = this.prevRms.length ? this.prevRms.reduce((a, b) => a + b, 0) / this.prevRms.length : rms;
    const onThr = Math.max(this.floor * cfg.onsetRatio, 3e-4);
    const offThr = Math.max(this.floor * cfg.offRatio, 1.5e-4);

    let rejected: FrameRejection | undefined;
    let frozenNow = false;

    if (this.state === 'silent' || this.state === 'frozen') {
      // le plancher suit le minimum : descend vite, remonte lentement (~25 s)
      if (rms < this.floor) this.floor = Math.max(rms, 1e-6); else if (rms < onThr) this.floor += (rms - this.floor) * 0.0002;
      if (rms > onThr && rms > 1.8 * prevMean) {
        this.state = 'attack';
        // l'attaque a pu commencer dans le bloc précédent
        this.onsetSample = this.blockStart - this.blockSize;
        this.frames = []; this.fusedFinal = undefined; this.belowCount = 0;
      }
    } else {
      if (rms < offThr) this.belowCount++; else this.belowCount = 0;
      if (this.belowCount >= 3) {
        this.state = 'frozen'; frozenNow = true;
        this.fusedFinal = this.fuse();
      } else if (rms > onThr && rms > 3 * prevMean) {
        // nouvelle frappe : on repart de zéro
        this.onsetSample = this.blockStart - this.blockSize; this.frames = []; this.state = 'attack'; rejected = 'retrigger';
      } else if (this.state === 'attack' && this.blockStart >= this.onsetSample + (cfg.transientMs / 1000) * cfg.sampleRate) {
        this.state = 'sustain';
      }
    }
    this.prevRms.push(rms); if (this.prevRms.length > 4) this.prevRms.shift();

    let frame: ProcessorEvent['frame'];
    // --- fenêtre d'analyse à chaque pas ---
    if (this.total >= cfg.frameSize && this.total - this.lastFrameEnd >= cfg.hop) {
      this.lastFrameEnd = this.total;
      if (this.state === 'attack' || this.state === 'sustain') {
        const r = this.analyzeFrame(offThr);
        if ('reason' in r) rejected = rejected ?? r.reason; else frame = r.frame;
      } else if (this.state === 'silent') {
        this.updateNoiseRef(offThr);
      }
    }

    return {
      time: this.total / cfg.sampleRate, state: this.state,
      rmsDb: 20 * Math.log10(rms + 1e-9), noiseFloorDb: 20 * Math.log10(this.floor + 1e-9),
      frame, rejected, frozenNow,
      fused: this.state === 'frozen' ? this.fusedFinal : this.fuse(),
    };
  }

  private frameSamples(): { data: Float32Array; start: number } {
    const N = this.cfg.frameSize, L = this.ring.length, start = this.total - N;
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

    const spec = this.analyzer.analyze(data);
    const noise = this.noiseDb(spec);
    const peaks = this.analyzer.pickPeaks(spec, noise, { fMin: cfg.fMinAnalysis, fMax: cfg.fMaxAnalysis, minSnrDb: cfg.minSnrDb });
    const fit = fitInharmonicity(peaks, { ...this.fitOpts, fMinAnalysis: cfg.fMinAnalysis, fMaxAnalysis: cfg.fMaxAnalysis });
    if (isRejection(fit)) return { reason: fit.rejected };
    const sigma = Math.max(0.05, fit.sigmaF0Cents);
    this.frames.push({ f0: fit.f0, f0c: 0, B: fit.B, sigma, fund: fit.fundamentalUsed });
    return { frame: { startSample: start, fit, note: this.identify(fit.f0) } };
  }

  /** Plancher spectral : bruit local, relevé par le plancher mesuré dans les silences. */
  private noiseDb(spec: Spectrum): Float64Array {
    const local = this.analyzer.noiseCurve(spec);
    if (!this.noiseRef || this.noiseRef.length !== local.length) return local;
    const out = new Float64Array(local.length);
    for (let i = 0; i < local.length; i++) out[i] = Math.max(local[i], this.noiseRef[i] + 3);
    return out;
  }

  private updateNoiseRef(offThr: number): void {
    for (const b of this.blockRms) if (b.start >= this.total - this.cfg.frameSize && b.rms >= offThr) return;
    const { data } = this.frameSamples();
    const spec = this.analyzer.analyze(data);
    const cur = this.analyzer.noiseCurve(spec);
    if (!this.noiseRef || this.noiseRef.length !== cur.length) this.noiseRef = cur;
    else for (let i = 0; i < cur.length; i++) this.noiseRef[i] = 0.8 * this.noiseRef[i] + 0.2 * cur[i];
  }

  /** Fusion des fenêtres valides : moyenne pondérée par 1/σ² (f0 en cents), B en log. */
  private fuse(): FusedMeasurement | undefined {
    const fr = this.frames;
    if (!fr.length) return undefined;
    const ref = fr[0].f0;
    let sw = 0, sc = 0, sb = 0;
    for (const f of fr) {
      const w = 1 / (f.sigma * f.sigma);
      sw += w; sc += w * centsBetween(f.f0, ref); sb += w * Math.log(Math.max(f.B, 1e-7));
    }
    const f0 = ref * Math.pow(2, sc / sw / 1200);
    return {
      f0, B: Math.exp(sb / sw), note: this.identify(f0),
      sigmaF0Cents: Math.sqrt(1 / sw), frames: fr.length, fundamentalUsed: fr.some(f => f.fund),
    };
  }
}
