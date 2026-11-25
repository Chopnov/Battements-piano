/// <reference lib="webworker" />
/**
 * AudioWorklet : transmet les échantillons bruts du micro au fil principal par paquets.
 * Aucun traitement ici : l'analyse (16384 échantillons, Blackman-Harris...) se fait dans AudioProcessor.
 */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const PACKET = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(PACKET);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === PACKET) {
        const out = this.buf;
        this.port.postMessage({ samples: out, sampleRate }, [out.buffer]);
        this.buf = new Float32Array(PACKET); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
