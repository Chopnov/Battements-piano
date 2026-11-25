import { useRef, useState } from 'react';
import { startMicrophone, type MicSession, type ProcessorEvent } from './dsp';
import { Dial } from './ui/DialView';

/** Écran d'accord : détection automatique de la note, cadran, mesure de B. Pas encore de courbe d'étirement (étape suivante). */
export function App() {
  const [live, setLive] = useState<{ note: string; cents: number; hz: number; B: number } | null>(null);
  const [state, setState] = useState<ProcessorEvent['state']>('silent');
  const [info, setInfo] = useState('');
  const [tol, setTol] = useState(2);
  const [la4, setLa4] = useState(440);
  const [running, setRunning] = useState(false);
  const sess = useRef<MicSession | null>(null);

  function onEvent(e: ProcessorEvent) {
    setState(e.state);
    if (e.state === 'silent') return;                        // on garde l'affichage figé jusqu'à la frappe suivante
    const m = e.fused ?? e.frame;
    if (e.state === 'attack' && !e.fused && !e.frame) { setLive(null); return; }
    if (e.frame) { const f = e.frame; setLive({ note: f.note.name, cents: f.note.cents, hz: f.fit.f0, B: f.fit.B }); }
    else if (e.frozenNow && e.fused) setLive({ note: e.fused.note.name, cents: e.fused.note.cents, hz: e.fused.f0, B: e.fused.B });
    void m;
  }

  async function toggle() {
    if (sess.current) { sess.current.stop(); sess.current = null; setRunning(false); return; }
    try {
      const s = await startMicrophone(onEvent);
      s.processor.setTarget(undefined, la4);
      sess.current = s; setRunning(true);
      const st = s.settings;
      setInfo(`${s.sampleRate} Hz · echo ${String(st.echoCancellation)} · bruit ${String(st.noiseSuppression)} · gain auto ${String(st.autoGainControl)}`);
    } catch (e) { setInfo('Micro refusé ou indisponible : ' + String(e)); }
  }

  return (
    <main className="mx-auto max-w-md p-4 min-h-screen bg-slate-950 text-slate-100">
      <h1 className="text-lg font-semibold">Accordeur Pro</h1>
      <div className="mt-3">
        <Dial note={live?.note ?? null} cents={live?.cents ?? null} hz={live?.hz} tolerance={tol}
          detail={live ? 'B ' + live.B.toExponential(2) : undefined} frozen={state === 'frozen'} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button onClick={toggle} className={'rounded-lg px-4 py-2 font-semibold ' + (running ? 'bg-rose-600' : 'bg-sky-600')}>{running ? 'Arrêter' : 'Écouter'}</button>
        <label>Zone juste ±
          <select value={tol} onChange={e => setTol(Number(e.target.value))} className="ml-1 rounded bg-slate-800 px-2 py-1">
            {[0.5, 1, 2, 3, 5].map(v => <option key={v} value={v}>{v} ct</option>)}
          </select>
        </label>
        <label>La4
          <input type="number" value={la4} min={410} max={470} step={0.5} className="ml-1 w-20 rounded bg-slate-800 px-2 py-1"
            onChange={e => { const v = Number(e.target.value); setLa4(v); sess.current?.processor.setTarget(undefined, v); }} />
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-400">{info || 'Joue une seule note, corde isolée. Le cadran suit la note détectée, mesure figée quand le son retombe.'}</p>
    </main>
  );
}
