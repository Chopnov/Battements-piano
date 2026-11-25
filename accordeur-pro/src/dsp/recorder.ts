/**
 * Enregistrement de validation : audio brut du micro (WAV mono, fréquence native, 48 kHz en principe)
 * + journal des mesures (note, cents, B, corrections), sur une horloge commune en échantillons.
 * But : rejouer plus tard un accord complet sur un vrai piano dans le banc d'essai, et comparer.
 *
 * L'audio est gardé en mémoire en PCM 24 bits (3 octets/échantillon : 144 Ko/s, environ 520 Mo
 * pour une heure). Le micro d'un téléphone ne dépasse pas 16 bits utiles ; 24 bits évitent
 * seulement toute perte au passage flottant -> entier.
 */

export interface LogEntry {
  /** Secondes depuis le début de l'enregistrement */
  t: number;
  /** Échantillon (dans le WAV) */
  sample: number;
  type: 'frappe' | 'correction' | 'reglage' | 'note' | 'marque' | 'pause' | 'reprise';
  [k: string]: unknown;
}

export interface RecorderOptions {
  /** 24 (défaut, PR étape 2) ou 16 bits : 16 bits suffisent pour un micro de téléphone et divisent la taille par 1,5 */
  bits?: 16 | 24;
  /**
   * Si fourni, chaque bloc plein (10 s) lui est confié au lieu d'être gardé en mémoire
   * (séances longues : stockage sur le téléphone au fil de l'eau, rien de perdu si l'appli plante).
   * wav() n'est alors plus disponible : le fichier se reconstitue depuis le stockage.
   */
  onChunk?: (bytes: Uint8Array, index: number) => void;
}

export class Recorder {
  readonly sampleRate: number;
  readonly bits: 16 | 24;
  private readonly onChunk?: (bytes: Uint8Array, index: number) => void;
  private readonly chunkBytes: number;
  private chunkIndex = 0;
  private paused = false;
  /** Échantillons du flux non enregistrés (pauses), pour garder le journal calé sur le WAV */
  private skipped = 0;
  private lastStream = 0;
  /** Échantillon du flux d'analyse qui correspond au début du WAV */
  readonly streamStart: number;
  readonly startedAt: Date;
  private chunks: Uint8Array[] = [];
  private cur: Uint8Array;
  private pos = 0;
  private n = 0;
  private peak = 0;
  readonly log: LogEntry[] = [];
  meta: Record<string, unknown> = {};

  constructor(sampleRate: number, streamStart = 0, now = new Date(), opts: RecorderOptions = {}) {
    this.sampleRate = sampleRate; this.streamStart = streamStart; this.startedAt = now;
    this.bits = opts.bits ?? 24; this.onChunk = opts.onChunk;
    this.chunkBytes = sampleRate * (this.bits / 8) * 10;   // 10 s par bloc
    this.cur = new Uint8Array(this.chunkBytes);
    this.lastStream = streamStart;
  }

  get isPaused(): boolean { return this.paused; }
  /** Pause (conversation avec le client, unissons…) : le son n'est plus gardé, le journal non plus. */
  pause(streamSample: number): void { if (this.paused) return; this.note('pause', streamSample, {}); this.paused = true; this.lastStream = streamSample; }
  resume(streamSample: number): void {
    if (!this.paused) return;
    this.skipped += Math.max(0, streamSample - this.lastStream); this.paused = false;
    this.note('reprise', streamSample, { pauseDe_s: +((streamSample - this.lastStream) / this.sampleRate).toFixed(1) });
  }
  /** Nombre de blocs déjà confiés à onChunk */
  get flushedChunks(): number { return this.chunkIndex; }

  private flush(): void {
    if (this.onChunk) { this.onChunk(this.pos === this.chunkBytes ? this.cur : this.cur.slice(0, this.pos), this.chunkIndex); this.cur = new Uint8Array(this.chunkBytes); }
    else { this.chunks.push(this.cur); this.cur = new Uint8Array(this.chunkBytes); }
    this.chunkIndex++; this.pos = 0;
  }

  /** Bloc en cours, pas encore plein (à stocker à l'arrêt) */
  tail(): Uint8Array { return this.cur.slice(0, this.pos); }

  get samples(): number { return this.n; }
  get seconds(): number { return this.n / this.sampleRate; }
  get bytes(): number { return this.n * (this.bits / 8); }
  /** Crête absolue depuis le début (1 = pleine échelle) */
  get peakLevel(): number { return this.peak; }

  push(x: Float32Array): void {
    if (this.paused) return;
    const b24 = this.bits === 24, scale = b24 ? 8388607 : 32767, bps = b24 ? 3 : 2;
    for (let i = 0; i < x.length; i++) {
      let v = x[i];
      const a = Math.abs(v); if (a > this.peak) this.peak = a;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      const q = Math.round(v * scale);
      if (this.pos + bps > this.chunkBytes) this.flush();
      this.cur[this.pos++] = q & 0xff; this.cur[this.pos++] = (q >> 8) & 0xff;
      if (b24) this.cur[this.pos++] = (q >> 16) & 0xff;
    }
    this.n += x.length;
  }

  /** Ajoute une ligne au journal ; streamSample = horloge du processeur (AudioProcessor.samplesSeen). */
  note(type: LogEntry['type'], streamSample: number, data: Record<string, unknown>): void {
    if (this.paused) return;
    const sample = Math.max(0, streamSample - this.streamStart - this.skipped);
    this.log.push({ t: +(sample / this.sampleRate).toFixed(4), sample, type, ...data });
  }

  /** Fichier WAV complet (PCM 24 bits mono). */
  wav(): Uint8Array {
    if (this.onChunk) throw new Error('enregistrement stocké au fil de l’eau : reconstituer le WAV depuis le stockage');
    const dataBytes = this.bytes, out = new Uint8Array(44 + dataBytes);
    out.set(wavHeader(dataBytes, this.sampleRate, this.bits), 0);
    let o = 44;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    out.set(this.cur.subarray(0, this.pos), o);
    return out;
  }

  /** Journal JSON : métadonnées + lignes. */
  journal(): string {
    return JSON.stringify({
      app: 'Accordeur Pro', format: 1, debut: this.startedAt.toISOString(),
      frequence: this.sampleRate, bits: this.bits, duree: +this.seconds.toFixed(3), crete: +this.peak.toFixed(4),
      ...this.meta, journal: this.log,
    }, null, 1);
  }

  /** Nom de fichier de base, ex. « accord-2026-11-25-1432 » */
  baseName(): string {
    const d = this.startedAt, p = (v: number) => String(v).padStart(2, '0');
    return `accord-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
}

/** En-tête WAV PCM mono de 44 octets, pour dataBytes octets de données. */
export function wavHeader(dataBytes: number, sampleRate: number, bits: 16 | 24): Uint8Array {
  const out = new Uint8Array(44), dv = new DataView(out.buffer), bps = bits / 8;
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * bps, true);
  dv.setUint16(32, bps, true); dv.setUint16(34, bits, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  return out;
}

/** Relit un WAV PCM 16/24 bits ou flottant 32 bits (mono ou moyenne des canaux). Utilisé par les tests et le banc d'essai. */
export function readWav(buf: Uint8Array): { sampleRate: number; data: Float32Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('pas un fichier WAV');
  let o = 12, fmt = 1, ch = 1, sr = 48000, bits = 16;
  while (o + 8 <= buf.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), b = o + 8;
    if (id === 'fmt ') { fmt = dv.getUint16(b, true); ch = dv.getUint16(b + 2, true); sr = dv.getUint32(b + 4, true); bits = dv.getUint16(b + 14, true); }
    if (id === 'data') {
      const bps = bits / 8, n = Math.floor(Math.min(size, buf.length - b) / (bps * ch)), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) {
          const p = b + (i * ch + c) * bps;
          if (fmt === 3 && bits === 32) acc += dv.getFloat32(p, true);
          else if (bits === 16) acc += dv.getInt16(p, true) / 32768;
          else if (bits === 24) acc += ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) << 8 >> 8) / 8388608;
          else throw new Error(`WAV ${bits} bits non pris en charge`);
        }
        out[i] = acc / ch;
      }
      return { sampleRate: sr, data: out };
    }
    o = b + size + (size & 1);
  }
  throw new Error('WAV sans données');
}
