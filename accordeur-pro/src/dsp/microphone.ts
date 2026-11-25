import { AudioProcessor, type ProcessorConfig } from './audioProcessor';
import type { ProcessorEvent } from './types';
// ?worker&url : Vite compile le TypeScript du worklet et renvoie son URL finale
import workletUrl from './worklet/captureProcessor?worker&url';

export interface MicSession {
  processor: AudioProcessor;
  /** Réglages réellement appliqués par le navigateur (à vérifier : certains téléphones les ignorent) */
  settings: MediaTrackSettings;
  sampleRate: number;
  stop(): void;
}

/**
 * Ouvre le micro SANS traitement (echoCancellation, noiseSuppression, autoGainControl désactivés),
 * à 48 kHz, et branche l'AudioWorklet sur un AudioProcessor.
 */
export async function startMicrophone(
  onEvent: (e: ProcessorEvent) => void,
  cfg: Partial<ProcessorConfig> = {},
): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48000,
    },
  });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(workletUrl);
  const processor = new AudioProcessor({ ...cfg, sampleRate: ctx.sampleRate });
  const node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  node.port.onmessage = (m: MessageEvent<{ samples: Float32Array }>) => {
    for (const ev of processor.push(m.data.samples)) onEvent(ev);
  };
  const src = ctx.createMediaStreamSource(stream);
  src.connect(node);
  await ctx.resume();
  return {
    processor, settings, sampleRate: ctx.sampleRate,
    stop() { node.port.onmessage = null; src.disconnect(); stream.getTracks().forEach(t => t.stop()); void ctx.close(); },
  };
}
