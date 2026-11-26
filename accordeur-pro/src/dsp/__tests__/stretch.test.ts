import { describe, it, expect } from 'vitest';
import { PROFILES, refinedB, stretchCurve, profileB, type OctaveType } from '../../tuning/stretch';

describe('courbe d’accord de la version d’essai', () => {
  const p = PROFILES[1];
  const B = refinedB(p, {});
  it('La4 = 0, graves bas, aigus hauts, étirement croissant avec le type d’octave', () => {
    const w: Record<string, number[]> = {};
    for (const o of ['2:1', '4:2', '6:3', 'mixte'] as OctaveType[]) {
      const d = stretchCurve(B, o); w[o] = d;
      expect(Math.abs(d[69])).toBeLessThan(1e-9);
      expect(d[21]).toBeLessThan(-5); expect(d[108]).toBeGreaterThan(10);
      for (let m = 22; m <= 108; m++) expect(d[m]).toBeGreaterThanOrEqual(d[m - 1] - 0.5);
    }
    expect(w['6:3'][108]).toBeGreaterThan(w['4:2'][108]); expect(w['4:2'][108]).toBeGreaterThan(w['2:1'][108]);
    console.log(['2:1', '4:2', '6:3', 'mixte'].map(o => `${o}: A0 ${w[o][21].toFixed(1)} A1 ${w[o][33].toFixed(1)} A2 ${w[o][45].toFixed(1)} A6 ${w[o][93].toFixed(1)} C8 ${w[o][108].toFixed(1)}`).join('\n'));
  });
  it('les mesures tirent la courbe localement, une mesure aberrante est écartée', () => {
    const r = refinedB(p, { 69: [profileB(p, 69) * 1.5, profileB(p, 69) * 1.5] });
    expect(r[69] / profileB(p, 69)).toBeGreaterThan(1.3);
    expect(Math.abs(r[30] / profileB(p, 30) - 1)).toBeLessThan(0.01);
    const o = refinedB(p, { 69: [profileB(p, 69) * 10] });
    expect(o[69]).toBeCloseTo(profileB(p, 69), 10);
  });
});
