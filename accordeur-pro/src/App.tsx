import { useEffect, useRef, useState } from 'react';
import { startMicrophone, NoteTracker, Recorder, noteName, FIRST_KEY, LAST_KEY, type MicSession, type ProcessorEvent } from './dsp';
import { Dial } from './ui/DialView';

const VERSION = '0.2.0';

interface Live { midi: number; note: string; cents: number; hz: number; B: number; tentative?: boolean; correction?: string }

const CORR: Record<string, string> = {
  glissement: 'touche suivante (note très fausse)',
  continuite: 'même touche (passage des ±50 ct)',
  saut: 'saut confirmé',
  manuel: 'corrigé à la main',
};

function save(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/** Écran d'accord : détection intelligente de la note (suivi de séquence), cadran, mesure de B, enregistrement de validation. */
export function App() {
  const [live, setLive] = useState<Live | null>(null);
  const [state, setState] = useState<ProcessorEvent['state']>('silent');
  const [info, setInfo] = useState('');
  const [tol, setTol] = useState(2);
  const [la4, setLa4] = useState(440);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState<string>('');
  const [rec, setRec] = useState<{ s: number; mb: number } | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const sess = useRef<MicSession | null>(null);
  const tracker = useRef(new NoteTracker());
  const recorder = useRef<Recorder | null>(null);
  const strike = useRef<{ onset: number; firstMs?: number }>({ onset: 0 });
  const prevState = useRef<ProcessorEvent['state']>('silent');

  const clock = () => sess.current?.processor.samplesSeen ?? 0;
  const logLine = (type: 'frappe' | 'correction' | 'reglage', data: Record<string, unknown>) => recorder.current?.note(type, clock(), data);
  const sync = () => { setCurrent(tracker.current.current); setLocked(tracker.current.isLocked); };

  function onEvent(e: ProcessorEvent) {
    if (e.committed) {
      const c = e.committed;
      sync();
      setPending(c.pendingJump ? `Saut vers ${noteName(c.pendingJump.midi)} ? ${c.pendingJump.count}/${c.pendingJump.needed} frappes` : '');
      logLine('frappe', {
        note: c.name, midi: c.midi, cents: +c.cents.toFixed(2), f0: +c.f0.toFixed(4), B: +c.B.toExponential(3),
        sigma: e.fused ? +e.fused.sigmaF0Cents.toFixed(3) : undefined, fenetres: e.fused?.frames,
        premiereLecture_ms: strike.current.firstMs !== undefined ? Math.round(strike.current.firstMs) : undefined,
        correction: c.correction, provisoire: c.tentative || undefined, sautEnAttente: c.pendingJump,
      });
    }
    // nouvelle frappe (après le bilan de la précédente, qui peut arriver sur le même événement)
    if (e.state === 'attack' && (prevState.current !== 'attack' || e.rejected === 'retrigger')) strike.current = { onset: e.time };
    prevState.current = e.state;
    setState(e.state);
    if (e.state === 'silent') return;                        // on garde l'affichage figé jusqu'à la frappe suivante
    if (e.state === 'attack' && !e.fused && !e.frame) { setLive(null); return; }
    if (e.frame) {
      const f = e.frame;
      if (strike.current.firstMs === undefined) { strike.current.firstMs = (e.time - strike.current.onset) * 1000; setLastMs(strike.current.firstMs); }
      setLive({ midi: f.note.midi, note: f.note.name, cents: f.note.cents, hz: f.fit.f0, B: f.fit.B, tentative: f.note.tentative, correction: f.note.correction });
    } else if (e.frozenNow && e.fused) {
      setLive(l => ({ midi: e.fused!.note.midi, note: e.fused!.note.name, cents: e.fused!.note.cents, hz: e.fused!.f0, B: e.fused!.B, tentative: l?.tentative, correction: l?.correction }));
    }
  }

  async function toggle() {
    if (sess.current) { if (recorder.current) stopRecording(); sess.current.stop(); sess.current = null; setRunning(false); return; }
    try {
      const s = await startMicrophone(onEvent, {}, x => recorder.current?.push(x));
      s.processor.setTarget(undefined, la4);
      s.processor.setTracker(tracker.current);
      sess.current = s; setRunning(true);
      const st = s.settings;
      setInfo(`${s.sampleRate} Hz · écho ${String(st.echoCancellation)} · bruit ${String(st.noiseSuppression)} · gain auto ${String(st.autoGainControl)}`);
    } catch (e) { setInfo('Micro refusé ou indisponible : ' + String(e)); }
  }

  function startRecording() {
    const s = sess.current; if (!s) return;
    const r = new Recorder(s.sampleRate, s.processor.samplesSeen);
    r.meta = {
      version: VERSION, la4, tolerance: tol, micro: s.settings, navigateur: navigator.userAgent,
      noteDepart: tracker.current.current !== undefined ? noteName(tracker.current.current) : 'auto',
      cadenas: tracker.current.isLocked, sens: tracker.current.direction,
    };
    recorder.current = r; setRec({ s: 0, mb: 0 });
  }

  function stopRecording() {
    const r = recorder.current; if (!r) return;
    recorder.current = null; setRec(null);
    if (r.samples < r.sampleRate * 0.5) return;
    const base = r.baseName();
    save(base + '.wav', r.wav(), 'audio/wav');
    save(base + '.json', r.journal(), 'application/json');
  }

  // durée de l'enregistrement en cours
  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => { const r = recorder.current; if (r) setRec({ s: r.seconds, mb: r.bytes / 1e6 }); }, 500);
    return () => clearInterval(id);
  }, [rec !== null]);

  function nudge(d: number) {
    const t = tracker.current;
    if (t.current === undefined) t.setCurrent(live?.midi ?? FIRST_KEY);
    const from = t.current!, to = t.nudge(d);
    sync(); setPending('');
    if (to !== undefined && live && live.midi === from && live.hz) {
      setLive({ ...live, midi: to, note: noteName(to), cents: 1200 * Math.log2(live.hz / (la4 * Math.pow(2, (to - 69) / 12))), correction: 'manuel', tentative: false });
    }
    logLine('correction', { type: 'manuel', de: noteName(from), vers: to !== undefined ? noteName(to) : undefined });
  }

  function toggleLock() {
    const t = tracker.current;
    if (t.current === undefined && live) t.setCurrent(live.midi);
    t.setLocked(!t.isLocked); sync();
    logLine('reglage', { cadenas: t.isLocked, note: t.current !== undefined ? noteName(t.current) : undefined });
  }

  function pick(v: string) {
    const t = tracker.current;
    if (v === '') t.resetSequence(); else t.setCurrent(Number(v));
    sync(); setPending('');
    logLine('reglage', { noteCourante: v === '' ? 'auto' : noteName(Number(v)) });
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const detail = live ? ['B ' + live.B.toExponential(2), live.tentative ? 'provisoire' : '', live.correction ? CORR[live.correction] : ''].filter(Boolean).join(' · ') : undefined;
  const btn = 'rounded-lg px-3 py-2 font-semibold bg-slate-800 active:bg-slate-700 disabled:opacity-40';

  return (
    <main className="mx-auto max-w-md p-4 min-h-screen bg-slate-950 text-slate-100">
      <h1 className="text-lg font-semibold">Accordeur Pro</h1>
      <div className="mt-3">
        <Dial note={live ? live.note + (live.tentative ? ' ?' : '') : null} cents={live?.cents ?? null} hz={live?.hz} tolerance={tol}
          detail={detail} frozen={state === 'frozen'} />
      </div>

      <div className="mt-3 flex items-center justify-center gap-2 text-sm">
        <button className={btn + ' text-lg w-12'} onClick={() => nudge(-1)} aria-label="Demi-ton plus bas">◀</button>
        <select value={current ?? ''} onChange={e => pick(e.target.value)} className="rounded bg-slate-800 px-2 py-2 w-28 text-center font-semibold">
          <option value="">Auto</option>
          {Array.from({ length: LAST_KEY - FIRST_KEY + 1 }, (_, i) => FIRST_KEY + i).map(m => <option key={m} value={m}>{noteName(m)} ({m - FIRST_KEY + 1})</option>)}
        </select>
        <button className={btn + ' text-lg w-12'} onClick={() => nudge(1)} aria-label="Demi-ton plus haut">▶</button>
        <button className={'rounded-lg px-3 py-2 font-semibold ' + (locked ? 'bg-amber-500 text-slate-950' : 'bg-slate-800')} onClick={toggleLock}
          aria-pressed={locked}>{locked ? '🔒 Cadenas' : '🔓 Cadenas'}</button>
      </div>
      <p className="mt-1 h-5 text-center text-xs text-amber-300">{pending}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button onClick={toggle} className={'rounded-lg px-4 py-2 font-semibold ' + (running ? 'bg-rose-600' : 'bg-sky-600')}>{running ? 'Arrêter' : 'Écouter'}</button>
        <button onClick={() => (rec ? stopRecording() : startRecording())} disabled={!running}
          className={'rounded-lg px-4 py-2 font-semibold disabled:opacity-40 ' + (rec ? 'bg-rose-700 animate-pulse' : 'bg-slate-700')}>
          {rec ? `⏹ ${fmt(rec.s)} · ${rec.mb.toFixed(0)} Mo` : '⏺ Enregistrer'}
        </button>
        <label>Zone juste ±
          <select value={tol} onChange={e => setTol(Number(e.target.value))} className="ml-1 rounded bg-slate-800 px-2 py-1">
            {[0.5, 1, 2, 3, 5].map(v => <option key={v} value={v}>{v} ct</option>)}
          </select>
        </label>
        <label>La4
          <input type="number" value={la4} min={410} max={470} step={0.5} className="ml-1 w-20 rounded bg-slate-800 px-2 py-1"
            onChange={e => {
              const v = Number(e.target.value); setLa4(v);
              sess.current?.processor.setTarget(undefined, v); tracker.current.setLa4(v);
              logLine('reglage', { la4: v });
            }} />
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {info || 'Joue une seule corde. La note suit la séquence (même note ou voisine) ; un grand saut demande 2 frappes, 3 pour une octave. ◀ ▶ corrigent la touche, le cadenas la bloque (cadenas + flèches = mode manuel).'}
      </p>
      {lastMs !== null && <p className="mt-1 text-xs text-slate-500">Première lecture : {Math.round(lastMs)} ms après l'attaque.</p>}
      <p className="mt-1 text-xs text-slate-500">L'enregistrement produit un WAV brut et un journal JSON (note, cents, B, corrections) à me renvoyer pour valider sur vrai piano.</p>
    </main>
  );
}
