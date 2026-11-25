export interface SpectralPeak {
  /** Fréquence interpolée (Hz) */
  freq: number;
  /** Amplitude crête estimée en dBFS (un sinus pleine échelle = 0 dB) */
  magDb: number;
  /** Rapport signal/bruit local en dB */
  snrDb: number;
}

export interface PartialMatch {
  k: number;
  freq: number;
  snrDb: number;
  magDb: number;
  /** Écart au modèle de Fletcher ajusté (cents) */
  residualCents: number;
  weight: number;
}

export interface FitResult {
  /** Fondamentale virtuelle (Hz), même si le pic k=1 est absent */
  f0: number;
  /** Coefficient d'inharmonicité B (f_k = k f0 sqrt(1 + B k²)) */
  B: number;
  /** Incertitude (1σ) sur f0 en cents, issue des résidus pondérés */
  sigmaF0Cents: number;
  sigmaB: number;
  partials: PartialMatch[];
  rmsCents: number;
  /** Part de l'énergie des pics significatifs expliquée par le modèle (0..1) */
  coherence: number;
  /** Vrai si un pic k=1 a été trouvé et utilisé */
  fundamentalUsed: boolean;
}

export type RejectReason =
  | 'no-peaks'
  | 'too-few-partials'
  | 'poor-fit'
  | 'low-coherence'
  | 'f0-out-of-range';

export interface FitRejection {
  rejected: RejectReason;
}

export type ProcessorState = 'silent' | 'attack' | 'sustain' | 'frozen';

export type FrameRejection = RejectReason | 'transient' | 'gate' | 'clipping' | 'retrigger';

/** Note identifiée automatiquement (touche la plus proche de f0 en tempérament égal) */
export interface DetectedNote {
  midi: number;
  name: string;
  /** Écart de f0 à la touche, en cents (tempérament égal, La4 réglé) */
  cents: number;
}

export interface FrameMeasurement {
  /** Échantillon (absolu) du début de la fenêtre d'analyse */
  startSample: number;
  fit: FitResult;
  note: DetectedNote;
}

export interface FusedMeasurement {
  f0: number;
  B: number;
  sigmaF0Cents: number;
  frames: number;
  fundamentalUsed: boolean;
  note: DetectedNote;
}

export interface ProcessorEvent {
  /** Temps (s) depuis le début du flux, à la fin du dernier échantillon traité */
  time: number;
  state: ProcessorState;
  rmsDb: number;
  noiseFloorDb: number;
  /** Mesure de la dernière fenêtre analysée (si valide) */
  frame?: FrameMeasurement;
  rejected?: FrameRejection;
  /** Mesure fusionnée sur toute la note (stable) ; figée quand le signal retombe */
  fused?: FusedMeasurement;
  /** Vrai à l'instant où la mesure est figée */
  frozenNow?: boolean;
}
