import { FFT } from './fft';
import { blackmanHarris } from './window';
import type { SpectralPeak } from './types';

export interface Spectrum {
  /** Amplitude crête en dBFS, bin par bin, de 0 à maxBin inclus */
  magDb: Float64Array;
  binHz: number;
}

export interface PeakOptions {
  fMin: number;
  fMax: number;
  /** Seuil de rapport signal/bruit (dB) pour retenir un pic */
  minSnrDb: number;
}

/**
 * Analyse spectrale : fenêtre de Blackman-Harris, zero-padding, spectre d'amplitude en dBFS.
 * L'interpolation parabolique se fait sur le spectre en dB (le lobe principal de la
 * Blackman-Harris est proche d'une gaussienne, donc parabolique en dB).
 */
export class SpectrumAnalyzer {
  readonly frameSize: number;
  readonly fftSize: number;
  readonly binHz: number;
  readonly maxBin: number;
  private fft: FFT;
  private win: Float64Array;
  private gain: number;
  private re: Float64Array;
  private im: Float64Array;

  constructor(readonly sampleRate: number, frameSize = 16384, zeroPad = 4, fMaxAnalysis = 12000) {
    this.frameSize = frameSize;
    this.fftSize = frameSize * zeroPad;
    this.binHz = sampleRate / this.fftSize;
    this.maxBin = Math.min(this.fftSize / 2 - 2, Math.floor(fMaxAnalysis / this.binHz));
    this.fft = new FFT(this.fftSize);
    this.win = blackmanHarris(frameSize);
    let s = 0;
    for (let i = 0; i < frameSize; i++) s += this.win[i];
    this.gain = 2 / s; // un sinus d'amplitude A donne un pic de A après ce facteur
    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
  }

  analyze(frame: Float32Array | Float64Array): Spectrum {
    const { re, im, win, frameSize } = this;
    re.fill(0); im.fill(0);
    let mean = 0;
    for (let i = 0; i < frameSize; i++) mean += frame[i];
    mean /= frameSize; // retire la composante continue (micro, ADC)
    for (let i = 0; i < frameSize; i++) re[i] = (frame[i] - mean) * win[i];
    this.fft.transform(re, im);
    const mag = new Float64Array(this.maxBin + 1);
    for (let i = 0; i <= this.maxBin; i++) {
      const a = Math.hypot(re[i], im[i]) * this.gain;
      mag[i] = 20 * Math.log10(a + 1e-12);
    }
    return { magDb: mag, binHz: this.binHz };
  }

  /**
   * Plancher de bruit local (dB) : 15e centile de la magnitude sur ±halfWidthHz, corrigé de
   * +6,3 dB pour retrouver la médiane d'un bruit blanc. Un centile bas, pas la médiane,
   * parce que dans les graves les partiels (lobes larges) occupent une grande part de la fenêtre.
   */
  noiseCurve(spec: Spectrum, halfWidthHz = 250): Float64Array {
    const n = spec.magDb.length, out = new Float64Array(n);
    const hw = Math.max(8, Math.round(halfWidthHz / spec.binHz)), step = Math.max(1, Math.round(hw / 8));
    const centers: number[] = [], vals: number[] = [];
    for (let c = 0; c < n + step; c += step) {
      const ci = Math.min(c, n - 1);
      const a = Math.max(0, ci - hw), b = Math.min(n, ci + hw + 1);
      const sub = Array.from(spec.magDb.subarray(a, b)).sort((x, y) => x - y);
      centers.push(ci); vals.push(sub[Math.floor(sub.length * 0.15)] + 6.3);
    }
    let j = 0;
    for (let i = 0; i < n; i++) {
      while (j < centers.length - 2 && centers[j + 1] <= i) j++;
      const c0 = centers[j], c1 = centers[Math.min(j + 1, centers.length - 1)];
      const t = c1 > c0 ? Math.min(1, Math.max(0, (i - c0) / (c1 - c0))) : 0;
      out[i] = vals[j] * (1 - t) + vals[Math.min(j + 1, vals.length - 1)] * t;
    }
    return out;
  }

  /** Pics locaux au-dessus du bruit, fréquence et amplitude affinées par interpolation parabolique. */
  pickPeaks(spec: Spectrum, noiseDb: Float64Array, o: PeakOptions): SpectralPeak[] {
    const m = spec.magDb, peaks: SpectralPeak[] = [];
    const lo = Math.max(2, Math.floor(o.fMin / spec.binHz)), hi = Math.min(m.length - 2, Math.ceil(o.fMax / spec.binHz));
    for (let i = lo; i <= hi; i++) {
      const b = m[i];
      if (!(b > m[i - 1] && b >= m[i + 1])) continue;
      const snr = b - noiseDb[i];
      if (snr < o.minSnrDb) continue;
      const a = m[i - 1], c = m[i + 1], d = a - 2 * b + c;
      const delta = d < 0 ? (0.5 * (a - c)) / d : 0;
      peaks.push({ freq: (i + delta) * spec.binHz, magDb: b - 0.25 * (a - c) * delta, snrDb: snr });
    }
    return peaks;
  }
}
