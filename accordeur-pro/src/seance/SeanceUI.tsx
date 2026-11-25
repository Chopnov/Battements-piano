import { useEffect, useState } from 'react';
import { noteName, FIRST_KEY, LAST_KEY } from '../dsp';
import { MODELES_YAMAHA, pianosConnus, typeDuModele, manques, type FicheSeance } from './fiche';
import { store, type SeanceMeta } from './store';

const champ = 'w-full rounded bg-slate-800 px-2 py-2';
const btn = 'rounded-lg px-3 py-2 font-semibold bg-slate-800 active:bg-slate-700 disabled:opacity-40';
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

/** Fiche du piano : à remplir quand on veut (pendant les unissons, à la fin). Seuls modèle et n° de série comptent vraiment. */
export function FicheSheet({ fiche, onChange, onClose, onExport, exporting }: {
  fiche: FicheSeance; onChange(f: FicheSeance): void; onClose(): void; onExport?: () => void; exporting?: boolean;
}) {
  const [releve, setReleve] = useState(false);
  const connus = pianosConnus();
  const p = fiche.piano;
  const setP = (patch: Partial<FicheSeance['piano']>) => onChange({ ...fiche, piano: { ...p, ...patch } });
  const set = (patch: Partial<FicheSeance>) => onChange({ ...fiche, ...patch });
  const manque = manques(fiche);

  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-slate-950/95 p-4">
      <div className="mx-auto max-w-md space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Fiche du piano</h2>
          <button className={btn} onClick={onClose}>Fermer</button>
        </div>

        {connus.length > 0 && (
          <label className="block">Piano déjà vu
            <select className={champ} value="" onChange={e => { const c = connus[Number(e.target.value)]; if (c) onChange({ ...fiche, piano: { ...c } }); }}>
              <option value="">—</option>
              {connus.map((c, i) => <option key={i} value={i}>{c.marque} {c.modele} {c.serie && '· n° ' + c.serie}</option>)}
            </select>
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label>Marque<input className={champ} value={p.marque} onChange={e => setP({ marque: e.target.value })} /></label>
          <label>Modèle
            <input className={champ} list="modeles" value={p.modele} placeholder="U3, C3X…"
              onChange={e => setP({ modele: e.target.value, type: p.type || typeDuModele(e.target.value) })} />
            <datalist id="modeles">{MODELES_YAMAHA.map(m => <option key={m} value={m} />)}</datalist>
          </label>
          <label>N° de série<input className={champ} inputMode="numeric" value={p.serie} onChange={e => setP({ serie: e.target.value })} /></label>
          <label>Année <span className="text-slate-500">(si pas de n°)</span>
            <input className={champ} inputMode="numeric" value={p.annee ?? ''} onChange={e => setP({ annee: num(e.target.value) })} /></label>
          <label>Type
            <select className={champ} value={p.type} onChange={e => setP({ type: e.target.value as FicheSeance['piano']['type'] })}>
              <option value="">—</option><option value="droit">Droit</option><option value="queue">Queue</option>
            </select>
          </label>
          <label>{p.type === 'queue' ? 'Longueur' : 'Hauteur'} (cm)
            <input className={champ} inputMode="decimal" value={p.tailleCm ?? ''} onChange={e => setP({ tailleCm: num(e.target.value) })} /></label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label>La4 visé (Hz)
            <input className={champ} inputMode="decimal" list="diapasons" value={fiche.la4} onChange={e => set({ la4: num(e.target.value) ?? 440 })} />
            <datalist id="diapasons">{[438, 440, 441, 442, 443, 444].map(v => <option key={v} value={v} />)}</datalist>
          </label>
          <label>Accordé avec
            <select className={champ} value={fiche.accordeurUtilise} onChange={e => set({ accordeurUtilise: e.target.value as FicheSeance['accordeurUtilise'] })}>
              <option>PTA-1</option><option>Accordeur Pro</option><option value="oreille">À l'oreille</option><option value="autre">Autre</option>
            </select>
          </label>
          <label className="col-span-2">Réglage de l'accordeur <span className="text-slate-500">(courbe, étirement)</span>
            <input className={champ} value={fiche.reglageAccordeur} onChange={e => set({ reglageAccordeur: e.target.value })} /></label>
          <label>Écart avant (ct)
            <input className={champ} inputMode="decimal" placeholder="-15" value={fiche.ecartAvantCents ?? ''} onChange={e => set({ ecartAvantCents: num(e.target.value) })} /></label>
          <label>Téléphone posé
            <select className={champ} value={fiche.position} onChange={e => set({ position: e.target.value as FicheSeance['position'] })}>
              <option value="pupitre">Sur le pupitre</option><option value="cadre">Sur le cadre</option><option value="table">Table d'harmonie</option>
              <option value="sol">Au sol</option><option value="autre">Autre</option>
            </select>
          </label>
          <label>Température (°C)<input className={champ} inputMode="decimal" value={fiche.temperature ?? ''} onChange={e => set({ temperature: num(e.target.value) })} /></label>
          <label>Humidité (%)<input className={champ} inputMode="decimal" value={fiche.humidite ?? ''} onChange={e => set({ humidite: num(e.target.value) })} /></label>
        </div>
        <label className="block">Remarques <span className="text-slate-500">(corde changée, note qui bouge, pianiste…)</span>
          <textarea className={champ} rows={2} value={fiche.remarques} onChange={e => set({ remarques: e.target.value })} /></label>

        <button className="text-sky-300 underline" onClick={() => setReleve(!releve)}>
          {releve ? 'Masquer' : 'Ajouter'} la lecture de l'accordeur habituel (facultatif, {Object.keys(fiche.releve).length} notes)
        </button>
        {releve && (
          <div>
            <p className="text-xs text-slate-400">Écart affiché par l'accordeur habituel à la fin, en cents. Seulement les notes que tu veux ; vide = pas relevé.</p>
            <div className="mt-2 grid grid-cols-4 gap-1">
              {Array.from({ length: LAST_KEY - FIRST_KEY + 1 }, (_, i) => i + 1).map(k => (
                <label key={k} className="text-xs text-slate-400">{noteName(FIRST_KEY + k - 1)}
                  <input className="w-full rounded bg-slate-800 px-1 py-1 text-slate-100" inputMode="decimal" value={fiche.releve[k] ?? ''}
                    onChange={e => { const v = num(e.target.value); const r = { ...fiche.releve }; if (v === undefined || isNaN(v)) delete r[k]; else r[k] = v; set({ releve: r }); }} />
                </label>
              ))}
            </div>
          </div>
        )}

        {onExport && (
          <div className="sticky bottom-0 bg-slate-950 py-3">
            {manque.length > 0 && <p className="mb-2 text-xs text-amber-300">Manque : {manque.join(', ')} (tu peux envoyer quand même).</p>}
            <button className="w-full rounded-lg bg-sky-600 px-4 py-3 font-semibold disabled:opacity-40" onClick={onExport} disabled={exporting}>
              {exporting ? 'Préparation des fichiers…' : 'Envoyer la séance (WAV + fiche)'}
            </button>
            <p className="mt-1 text-xs text-slate-500">Choisis Drive dans la feuille de partage, dossier « Accordeur Pro – séances ».</p>
          </div>
        )}
      </div>
    </div>
  );
}

const INTERVALLES = [
  { nom: 'Octave', dt: 12 }, { nom: 'Double octave', dt: 24 }, { nom: 'Quinte', dt: 7 }, { nom: 'Douzième', dt: 19 },
];

/**
 * Test d'intervalle à l'oreille : note du bas seule, du haut seule, puis les deux ensemble (4–5 s chacune),
 * et le verdict de l'accordeur. L'analyse mesurera les battements des partiels coïncidents et les comparera.
 */
export function IntervalTest({ courante, onMark, onClose }: {
  courante?: number; onMark(data: Record<string, unknown>): void; onClose(): void;
}) {
  const [bas, setBas] = useState<number>(courante !== undefined ? Math.max(FIRST_KEY, courante - 12) : 53); // Fa3 par défaut
  const [dt, setDt] = useState(12);
  const [fait, setFait] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<string>('');
  const [paire, setPaire] = useState<string>('');
  const haut = Math.min(LAST_KEY, bas + dt);
  const nom = INTERVALLES.find(i => i.dt === dt)?.nom ?? '';
  const id = `${noteName(bas)}-${noteName(haut)}`;
  const mark = (etape: string, extra: Record<string, unknown> = {}) => {
    onMark({ test: 'intervalle', intervalle: nom, bas: noteName(bas), haut: noteName(haut), midiBas: bas, midiHaut: haut, etape, ...extra });
    setFait(f => [...f, etape]);
  };
  const suivant = () => { setBas(b => Math.min(LAST_KEY - dt, b + 1)); setFait([]); setVerdict(''); setPaire(''); };
  const etapeBtn = (etape: string, label: string) => (
    <button className={btn + (fait.includes(etape) ? ' ring-2 ring-emerald-400' : '')} onClick={() => mark(etape)}>{label}</button>
  );

  useEffect(() => { setFait([]); setVerdict(''); setPaire(''); }, [bas, dt]);

  return (
    <div className="mt-3 rounded-xl border border-slate-700 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Test d'intervalle</h2>
        <button className="text-slate-400" onClick={onClose}>Fermer</button>
      </div>
      <div className="mt-2 flex gap-2">
        <select className="rounded bg-slate-800 px-2 py-2" value={dt} onChange={e => setDt(Number(e.target.value))}>
          {INTERVALLES.map(i => <option key={i.dt} value={i.dt}>{i.nom}</option>)}
        </select>
        <select className="rounded bg-slate-800 px-2 py-2" value={bas} onChange={e => setBas(Number(e.target.value))}>
          {Array.from({ length: LAST_KEY - dt - FIRST_KEY + 1 }, (_, i) => FIRST_KEY + i).map(m => <option key={m} value={m}>{noteName(m)}–{noteName(m + dt)}</option>)}
        </select>
      </div>
      <p className="mt-2 text-xs text-slate-400">Touche un bouton au moment de jouer, laisse sonner 4–5 s.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {etapeBtn('bas', `${noteName(bas)} seul`)}{etapeBtn('haut', `${noteName(haut)} seul`)}{etapeBtn('ensemble', 'Les deux')}
      </div>
      <p className="mt-3 text-xs text-slate-400">Ton verdict à l'oreille sur {id} :</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {['juste', 'large', 'étroite'].map(v => (
          <button key={v} className={btn + (verdict === v ? ' bg-emerald-700' : '')} onClick={() => setVerdict(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
        ))}
      </div>
      {dt === 12 && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="self-center text-slate-400">Jugée sur</span>
          {['2:1', '4:2', '6:3', 'je ne sais pas'].map(v => (
            <button key={v} className={btn + ' py-1' + (paire === v ? ' bg-emerald-700' : '')} onClick={() => setPaire(v)}>{v}</button>
          ))}
        </div>
      )}
      <button className="mt-3 w-full rounded-lg bg-sky-700 px-3 py-2 font-semibold disabled:opacity-40" disabled={!verdict}
        onClick={() => { mark('verdict', { verdict, paire: paire || undefined }); suivant(); }}>
        Noter et passer à {noteName(bas + 1)}–{noteName(bas + 1 + dt)}
      </button>
    </div>
  );
}

/** Séances restées sur le téléphone (pas encore envoyées, ou interrompues). */
export function SeancesEnAttente({ onExport, refresh }: { onExport(m: SeanceMeta): void; refresh: number }) {
  const [liste, setListe] = useState<SeanceMeta[]>([]);
  useEffect(() => { store.liste().then(l => setListe(l.sort((a, b) => b.debut.localeCompare(a.debut)))).catch(() => setListe([])); }, [refresh]);
  if (!liste.length) return null;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 p-3 text-xs">
      <p className="font-semibold text-slate-300">Séances sur ce téléphone</p>
      {liste.map(m => (
        <div key={m.id} className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-slate-400">
            {new Date(m.debut).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {(m.octets / (m.sampleRate * m.bits / 8) / 60).toFixed(0)} min
            {!m.termine && ' · interrompue'}{m.nomFichier ? ' · envoyée' : ''}
          </span>
          <button className={btn + ' py-1'} onClick={() => onExport(m)}>{m.nomFichier ? 'Renvoyer' : 'Envoyer'}</button>
          {m.nomFichier && <button className="px-2 text-rose-400" onClick={() => { void store.supprimer(m.id).then(() => setListe(l => l.filter(x => x.id !== m.id))); }}>Effacer</button>}
        </div>
      ))}
    </div>
  );
}
