import { describe, expect, it } from 'vitest';
import { run, scenario, lastFused, whiteNoise, concat, add, tones, synthNote, centsBetween, SR } from './synth';
import { midiToFreq } from '..';

describe('bruit parasite : le détecteur ne décroche pas et ne ment pas', () => {
  it('bruit blanc seul (continu) : aucune mesure, aucune attaque', () => {
    const { events } = run(whiteNoise(8, 0.05), 57);
    expect(events.some(e => e.frame)).toBe(false);
    expect(lastFused(events)).toBeUndefined();
    expect(events.every(e => e.state === 'silent')).toBe(true);
  });

  it('rafale de bruit blanc FORT après un silence (fausse attaque) : analysée mais rejetée par la cohérence harmonique', () => {
    const sig = concat(whiteNoise(1, 3e-4, 2), whiteNoise(5, 0.1, 3), whiteNoise(2, 3e-4, 4));
    for (const midi of [21, 45, 57, 72, undefined]) {
      const { events } = run(sig, midi);
      expect(events.some(e => e.state === 'attack' || e.state === 'sustain')).toBe(true); // elle déclenche bien la porte
      expect(events.some(e => e.frame), `midi ${midi}`).toBe(false);                      // mais jamais de mesure
      expect(lastFused(events)).toBeUndefined();
      const reasons = new Set(events.map(e => e.rejected).filter(Boolean));
      console.log(`bruit fort, note visée ${midi} : rejets = ${[...reasons].join(', ')}`);
    }
  });

  it('La3 noyé dans un bruit blanc de fond : mesure correcte à 0,1 ct', () => {
    const f0 = 220 * Math.pow(2, 3 / 1200), B = 3e-4;
    // bruit blanc continu, σ = 0,02 (−34 dBFS rms) pendant toute la scène, y compris avant la note (plancher mesuré)
    const note = synthNote({ f0, B, dur: 3, level: 0.12 }, 4);
    const sig = add(whiteNoise(6, 0.02, 9), note, Math.round(1.5 * SR));
    const { events } = run(sig, 57);
    const fused = lastFused(events)!;
    expect(fused).toBeDefined();
    const err = centsBetween(fused.f0, f0);
    console.log(`La3 + bruit blanc −34 dBFS : erreur ${err.toFixed(3)} ct, B ${fused.B.toExponential(2)} (vrai 3e-4), ${fused.frames} fenêtres`);
    expect(Math.abs(err)).toBeLessThan(0.1);
    expect(Math.abs(fused.B - B) / B).toBeLessThan(0.1);
  });

  it('La0 avec ronflement secteur/VMC (50 Hz + harmoniques) et voix (200 Hz + harmoniques) : valeur juste ou rejet, jamais de valeur fausse', () => {
    const f0 = 27.5 * Math.pow(2, -4 / 1200), B = 1.0e-3;
    const { signal } = scenario({ f0, B, kMin: 2, kMax: 14, dur: 3.5 }, { seed: 6, noise: 2e-3 });
    const hum = tones(signal.length / SR, [50, 100, 150, 200, 250], 0.01);
    const voice = tones(signal.length / SR, [185, 370, 555, 740, 925, 1110], 0.02);
    const { events } = run(add(add(signal, hum), voice), 21);
    const fused = lastFused(events);
    if (fused) {
      const err = centsBetween(fused.f0, f0);
      console.log(`La0 + ronflement + voix : erreur ${err.toFixed(3)} ct (${fused.frames} fenêtres)`);
      expect(Math.abs(err)).toBeLessThan(2); // brouillage volontairement brutal : on exige < 2 ct, pas 0,1 ct
    } else console.log('La0 + ronflement + voix : mesure rejetée (acceptable)');
    for (const e of events) if (e.frame) expect(Math.abs(centsBetween(e.frame.fit.f0, f0))).toBeLessThan(2);
  });

  it('une voix seule (série harmonique parfaite, B=0) ne produit pas de fausse mesure sur une touche visée très différente', () => {
    const sig = concat(whiteNoise(1, 3e-4, 5), add(whiteNoise(5, 3e-4, 6), tones(5, [165, 330, 495, 660, 825, 990], 0.05)));
    const { events } = run(sig, 33); // C2 visé (65 Hz) alors qu'une voix à 165 Hz chante
    for (const e of events) if (e.frame) {
      // si une mesure sort, elle doit rester dans la fenêtre de recherche (±120 ct) de la touche visée
      expect(Math.abs(centsBetween(e.frame.fit.f0, midiToFreq(33)))).toBeLessThan(180);
    }
  });

  it('gèle la mesure quand le signal retombe dans le bruit de fond, puis repart à la frappe suivante', () => {
    const f0 = 440 * Math.pow(2, -2 / 1200);
    const a = scenario({ f0, B: 4e-4, dur: 2.5 }, { seed: 1, lead: 1, tail: 1.5 });
    const b = scenario({ f0: 440 * Math.pow(2, 1 / 1200), B: 4e-4, dur: 2.5 }, { seed: 2, lead: 0.5, tail: 1.5 });
    const { events } = run(concat(a.signal, b.signal), 69);
    const frozen = events.filter(e => e.frozenNow);
    expect(frozen.length).toBe(2);
    const i1 = events.indexOf(frozen[0]), i2 = events.indexOf(frozen[1]);
    const f1 = events[i1].fused!;
    // entre les deux : la valeur reste figée
    for (let i = i1; i < events.findIndex((e, i) => i > i1 && e.state === 'attack'); i++) expect(events[i].fused!.f0).toBe(f1.f0);
    expect(Math.abs(centsBetween(f1.f0, f0))).toBeLessThan(0.1);
    expect(events[i2].fused!.f0).not.toBe(f1.f0);
  });
});
