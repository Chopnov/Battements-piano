/** Fenêtre de Blackman-Harris 4 termes (lobes secondaires < −92 dB), version périodique pour l'analyse spectrale. */
export function blackmanHarris(n: number): Float64Array {
  const w = new Float64Array(n);
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
  }
  return w;
}
