import { describe, it, expect } from 'vitest';
import { Recorder, readWav, wavHeader } from '../recorder';
import { nomFichier, ficheVide, typeDuModele, manques } from '../../seance/fiche';
import { journalAvecFiche } from '../../seance/exporter';

const sine = (n: number, sr: number, f = 440, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / sr));

describe('enregistrement de séance', () => {
  it('16 bits par blocs confiés au stockage : WAV reconstitué identique au signal', () => {
    const sr = 48000, blocs: Uint8Array[] = [];
    const r = new Recorder(sr, 0, new Date(), { bits: 16, onChunk: (b, i) => { expect(i).toBe(blocs.length); blocs.push(b); } });
    const x = sine(sr * 25 + 123, sr);
    for (let i = 0; i < x.length; i += 128) r.push(x.subarray(i, i + 128));
    expect(blocs.length).toBe(2);                       // 2 blocs pleins de 10 s, le reste en cours
    expect(() => r.wav()).toThrow();
    const parts = [...blocs, r.tail()], n = parts.reduce((a, b) => a + b.length, 0);
    expect(n).toBe(x.length * 2);
    const file = new Uint8Array(44 + n); file.set(wavHeader(n, sr, 16)); let o = 44;
    for (const p of parts) { file.set(p, o); o += p.length; }
    const back = readWav(file);
    expect(back.sampleRate).toBe(sr); expect(back.data.length).toBe(x.length);
    let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(back.data[i] - x[i]));
    expect(err).toBeLessThan(1 / 32000);
  });

  it('24 bits en mémoire (comportement de la PR étape 2) inchangé', () => {
    const r = new Recorder(48000); const x = sine(5000, 48000); r.push(x);
    const back = readWav(r.wav()); expect(back.data.length).toBe(5000);
    expect(Math.abs(back.data[100] - x[100])).toBeLessThan(1e-6);
  });

  it('pause : le son n’est pas gardé et le journal reste calé sur le WAV', () => {
    const sr = 1000, r = new Recorder(sr, 500, new Date(), { bits: 16 });
    r.push(new Float32Array(1000));                       // flux 500 → 1500
    r.pause(1500); r.push(new Float32Array(3000));        // ignoré
    r.resume(4500); r.push(new Float32Array(1000));
    r.note('frappe', 5000, { note: 'A4' });
    expect(r.samples).toBe(2000);
    const f = r.log.find(l => l.type === 'frappe')!;
    expect(f.sample).toBe(1500);                          // 5000 − 500 de départ − 3000 de pause
    expect(r.log.map(l => l.type)).toEqual(['pause', 'reprise', 'frappe']);
  });
});

describe('fiche du piano', () => {
  it('nom de fichier, type deviné, champs manquants, journal fusionné', () => {
    const f = ficheVide(442); f.piano.modele = 'U3'; f.piano.serie = '5 123 456';
    expect(nomFichier(new Date(2026, 10, 25, 14, 32), f)).toBe('2026-11-25_1432_Yamaha-U3_5-123-456');
    expect(typeDuModele('C3X')).toBe('queue'); expect(typeDuModele('U1')).toBe('droit'); expect(typeDuModele('G2')).toBe('queue');
    expect(manques(f)).toEqual([]); expect(manques(ficheVide())).toContain('modèle');
    const j = JSON.parse(journalAvecFiche(JSON.stringify({ app: 'Accordeur Pro', journal: [] }), f));
    expect(j.fiche.piano.modele).toBe('U3'); expect(j.app).toBe('Accordeur Pro');
  });
});
