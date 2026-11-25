import { describe, expect, it } from 'vitest';
import { run, scenario, lastFused, centsBetween } from './synth';
import { BCurve, REFERENCE_NOTES, REFERENCE_NAMES, computeTuningTargets, beatHz, targetPartialHz, midiToFreq, PRESETS, type BMeasurement } from '..';

/**
 * B « de référence » aux 7 notes repères, valeurs plausibles (ordres de grandeur de la littérature) :
 * - GB1 : petit queue (1,51 m), cordes courtes et raides -> B élevé, surtout dans les graves.
 * - C7 : grand queue de concert (2,27 m) -> B faible.
 * Le saut au passage cordes filées -> acier nu (D2 -> C3) est volontaire.
 */
const GB1: number[] = [1.3e-3, 8.5e-4, 5.5e-4, 9.0e-4, 8.0e-4, 1.1e-3, 1.9e-3];
const C7: number[] = [2.6e-4, 1.9e-4, 1.5e-4, 2.6e-4, 2.2e-4, 3.4e-4, 6.5e-4];
const asMeas = (b: number[]): BMeasurement[] => REFERENCE_NOTES.map((m, i) => ({ midi: m, B: b[i] }));
const trueCurve = { GB1: new BCurve(asMeas(GB1)), C7: new BCurve(asMeas(C7)) };

/** Mesure B sur un piano synthétique, note par note, avec la chaîne complète (micro simulé -> AudioProcessor). */
function measureReferenceNotes(trueB: BCurve, seed: number): BMeasurement[] {
  return REFERENCE_NOTES.map((midi, i) => {
    const B = trueB.at(midi), f0 = midiToFreq(midi) * Math.pow(2, (i % 3 - 1) * 8 / 1200); // notes un peu fausses, comme avant accordage
    const { signal } = scenario({ f0, B, kMin: midi < 40 ? 2 : 1, kMax: 12, dur: 3 }, { seed: seed + i });
    const fused = lastFused(run(signal, midi).events);
    expect(fused, `mesure ${REFERENCE_NAMES[i]}`).toBeDefined();
    return { midi, B: fused!.B };
  });
}

describe('GB1 (B élevé) contre C7 (B faible)', () => {
  const meas = { GB1: measureReferenceNotes(trueCurve.GB1, 10), C7: measureReferenceNotes(trueCurve.C7, 50) };

  it('le moteur mesure B sur les 7 notes repères', () => {
    for (const piano of ['GB1', 'C7'] as const) {
      meas[piano].forEach((m, i) => {
        const vrai = trueCurve[piano].at(m.midi);
        const err = Math.abs(m.B - vrai) / vrai;
        console.log(`${piano} ${REFERENCE_NAMES[i]} : B mesuré ${m.B.toExponential(2)}, vrai ${vrai.toExponential(2)}, écart ${(err * 100).toFixed(1)} %`);
        expect(err).toBeLessThan(0.05);
      });
    }
  });

  it('le GB1 a un B plus grand que le C7 sur les 88 touches', () => {
    const g = new BCurve(meas.GB1), c = new BCurve(meas.C7);
    for (let n = 21; n <= 108; n++) expect(g.at(n)).toBeGreaterThan(c.at(n));
  });

  it('la courbe interpolée reste proche de la courbe vraie entre les repères', () => {
    for (const piano of ['GB1', 'C7'] as const) {
      const est = new BCurve(meas[piano]), vrai = trueCurve[piano];
      for (let n = 21; n <= 84; n++) {
        const r = est.at(n) / vrai.at(n);
        expect(r).toBeGreaterThan(0.9); expect(r).toBeLessThan(1.1);
      }
    }
  });

  it('gère le décrochage cordes filées / acier : saut de B à la barre des graves, courbe continue de part et d’autre', () => {
    const c = new BCurve(asMeas(GB1)), br = c.breakMidi;
    const jump = c.at(br + 1) / c.at(br);
    console.log(`GB1 : B(${br}) = ${c.at(br).toExponential(2)}, B(${br + 1}) = ${c.at(br + 1).toExponential(2)} (×${jump.toFixed(2)})`);
    // pas d'interpolation « à travers » la barre : le côté acier n'hérite pas de la valeur filée
    expect(jump).toBeGreaterThan(1.3); // le saut des cordes filées vers l'acier nu est conservé
    for (let n = 22; n <= br; n++) expect(Math.abs(Math.log(c.at(n) / c.at(n - 1)))).toBeLessThan(0.3);
    for (let n = br + 2; n <= 108; n++) expect(Math.abs(Math.log(c.at(n) / c.at(n - 1)))).toBeLessThan(0.3);
  });

  it('les cibles : plus d’étirement sur le GB1 que sur le C7, symétrique autour de La4', () => {
    const tg = computeTuningTargets(new BCurve(meas.GB1)), tc = computeTuningTargets(new BCurve(meas.C7));
    const at = (t: typeof tg, m: number) => t[m - 21].centsFromET;
    for (const [nom, t] of [['GB1', tg], ['C7', tc]] as const) {
      console.log(`${nom} standard : A0 ${at(t, 21).toFixed(1)} ct, C2 ${at(t, 36).toFixed(1)}, A3 ${at(t, 57).toFixed(1)}, A4 ${at(t, 69).toFixed(2)}, C6 ${at(t, 84).toFixed(1)}, C8 ${at(t, 108).toFixed(1)}`);
    }
    expect(at(tg, 69)).toBeCloseTo(0, 3);
    expect(at(tg, 21)).toBeLessThan(at(tc, 21));          // basse plus basse
    expect(at(tg, 108)).toBeGreaterThan(at(tc, 108));     // aiguë plus haute
    expect(at(tg, 21)).toBeLessThan(0); expect(at(tg, 108)).toBeGreaterThan(0);
    expect(Math.abs(at(tg, 21) - at(tc, 21))).toBeGreaterThan(5);
  });

  it('Doux < Standard < Concert en amplitude d’étirement', () => {
    const c = new BCurve(meas.GB1);
    const span = (p: keyof typeof PRESETS) => { const t = computeTuningTargets(c, { stretch: p }); return t[108 - 21].centsFromET - t[0].centsFromET; };
    console.log(`GB1 amplitude A0→C8 : doux ${span('doux').toFixed(1)}, standard ${span('standard').toFixed(1)}, concert ${span('concert').toFixed(1)} ct`);
    expect(span('doux')).toBeLessThan(span('standard'));
    expect(span('standard')).toBeLessThan(span('concert'));
  });

  it('minimise les battements : Doux favorise le 2:1, Standard le 4:2, Concert rapproche le 6:3 (écarts en cents)', () => {
    const c = new BCurve(meas.C7);
    // écart de coïncidence, en cents, entre le partiel 2j de A3 et le partiel j de A4
    const dev = (p: keyof typeof PRESETS, j: number) => {
      const t = computeTuningTargets(c, { stretch: p });
      return Math.abs(1200 * Math.log2(targetPartialHz(t[57 - 21], 2 * j) / targetPartialHz(t[69 - 21], j)));
    };
    const row = (p: keyof typeof PRESETS) => [1, 2, 3].map(j => dev(p, j));
    for (const p of ['doux', 'standard', 'concert'] as const) console.log(`C7 A3–A4, ${p} : 2:1 ${row(p)[0].toFixed(2)} ct | 4:2 ${row(p)[1].toFixed(2)} ct | 6:3 ${row(p)[2].toFixed(2)} ct`);
    expect(row('doux')[0]).toBeLessThan(row('doux')[2]);
    // Concert : compromis 6:3 / 4:2 / douzième, le 6:3 se rapproche à mesure que l'étirement augmente
    expect(row('concert')[2]).toBeLessThan(row('standard')[2]);
    expect(row('standard')[2]).toBeLessThan(row('doux')[2]);
    expect(row('standard')[1]).toBeLessThan(row('standard')[0]);
    expect(row('standard')[1]).toBeLessThan(row('standard')[2]);
    const t = computeTuningTargets(c, { stretch: 'standard' });
    console.log(`C7 standard A3–A4 : battement 4:2 = ${beatHz(t[57 - 21], t[69 - 21], 4, 2).toFixed(3)} Hz`);
  });

  it('la courbe de cibles reste lisse (pas de saut entre touches voisines hors barre des graves)', () => {
    const t = computeTuningTargets(new BCurve(meas.GB1));
    for (let i = 2; i < t.length; i++) {
      const dd = t[i].centsFromET - 2 * t[i - 1].centsFromET + t[i - 2].centsFromET;
      expect(Math.abs(dd)).toBeLessThan(3);
    }
  });

  it('calibration : une note repère mesurée à ±0,1 ct ne dépend pas d’un piano précis (même moteur, deux B)', () => {
    const a = lastFused(run(scenario({ f0: 220, B: 6e-4, dur: 3 }, { seed: 5 }).signal, 57).events)!;
    const b = lastFused(run(scenario({ f0: 220, B: 2e-4, dur: 3 }, { seed: 5 }).signal, 57).events)!;
    expect(Math.abs(centsBetween(a.f0, 220))).toBeLessThan(0.1);
    expect(Math.abs(centsBetween(b.f0, 220))).toBeLessThan(0.1);
    expect(a.B).toBeGreaterThan(b.B * 2);
  });
});
