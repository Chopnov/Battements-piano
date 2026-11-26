import { useEffect, useMemo, useRef, useState } from 'react';
import { startMicrophone, NoteTracker, type MicSession, type ProcessorEvent } from './dsp';
import { Strobe, newLive, type LiveState } from './ui/Strobe';
import { Curve } from './ui/Curve';
import {
  PROFILES, OCTAVES, profileB, refinedB, stretchCurve, toleranceFor, frLabel, medianB, isOutlier,
  type Measures, type OctaveType,
} from './tuning/stretch';
import { constraintsFor, combine, test3m6M, noteLabel, partial, type Tuned, type Constraint } from './tuning/reference';

export const VERSION = '0.6.0-essai';

/** Notes proposées pour la mesure rapide « médium » : un La par octave de La2 à La6. */
const QUICK = [45, 57, 69, 81, 93];
const PRESETS_HZ = [438, 440, 441, 442, 443, 444];

interface Saved { v?: number; la4: number; offset: number; profile: string; oct: OctaveType; meas: Measures; tuned: Tuned }
// octaves mixtes par défaut : en 4:2 les octaves des basses sortaient trop serrées au premier essai
const DEFAULTS: Saved = { v: 2, la4: 440, offset: 0, profile: 'droit', oct: 'mixte', meas: {}, tuned: {} };
const KEY = 'accordeur-pro-essai';
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (s.v !== 2) { s.v = 2; s.oct = DEFAULTS.oct; }   // réglages de la 1re version : on repasse en mixte
    return { ...DEFAULTS, ...s };
  } catch { return DEFAULTS; }
}

interface Detail { midi: number; parts: Constraint[]; cents: number; curve: number; test: ReturnType<typeof test3m6M> }

const fmt = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const pill = 'rounded-full border border-[#222a34] bg-[#12161c] px-3 py-1.5 text-[13px] font-medium whitespace-nowrap active:bg-[#1a2029]';
const chip = 'rounded-lg border border-[#222a34] bg-[#12161c] px-3 py-2 text-sm active:bg-[#1a2029]';

/** Écran d'accord de la version d'essai : stroboscope sur la courbe d'accord, courbe dessous, mesure rapide d'inharmonicité. */
export function App() {
  const [cfg, setCfg] = useState<Saved>(load);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [current, setCurrent] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [lastMeasured, setLastMeasured] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'' | 'hz' | 'piano'>('');
  const [view, setView] = useState<'accord' | 'B'>('accord');

  const live = useRef<LiveState>(newLive());
  const sess = useRef<MicSession | null>(null);
  const tracker = useRef(new NoteTracker());
  const prevState = useRef<ProcessorEvent['state']>('silent');
  const wake = useRef<WakeLockSentinel | null>(null);

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* stockage indisponible */ } }, [cfg]);

  const profile = PROFILES.find(p => p.id === cfg.profile) ?? PROFILES[1];
  const { B, Bp, dev } = useMemo(() => {
    const B = refinedB(profile, cfg.meas), Bp: number[] = [];
    for (let m = 21; m <= 108; m++) Bp[m] = profileB(profile, m);
    return { B, Bp, dev: stretchCurve(B, cfg.oct) };
  }, [profile, cfg.meas, cfg.oct]);

  // Cible en cents de la fondamentale virtuelle (ce que mesure le moteur) : la courbe vise la 1re partielle, f1 = f0·√(1+B).
  const target = useRef<(m: number) => number>(() => 0);
  target.current = (m: number) => (dev[m] ?? 0) + cfg.offset - 600 * Math.log2(1 + (B[m] ?? 0));
  const measRef = useRef(measuring); measRef.current = measuring; live.current.measuring = measuring;
  const la4Ref = useRef(cfg.la4); la4Ref.current = cfg.la4;
  const tunedRef = useRef(cfg.tuned); tunedRef.current = cfg.tuned;
  const octRef = useRef(cfg.oct); octRef.current = cfg.oct;
  const detail = useRef<Detail | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  function onEvent(e: ProcessorEvent) {
    const S = live.current;
    const c = e.committed;
    // B appris sur chaque note jouée (pas seulement en mode mesure) : la courbe colle au piano au fil de l'accord
    if (c && !c.tentative && c.B > 1e-5 && c.B < 0.05) {
      setCfg(s => ({ ...s, meas: { ...s.meas, [c.midi]: [...(s.meas[c.midi] ?? []), c.B].slice(-5) } }));
      if (measRef.current) setLastMeasured(c.midi);
    }
    // note laissée juste : on la mémorise telle qu'elle sonne (f0 des 0,5 dernières s, B de la frappe) pour viser les suivantes
    // une note déjà en mémoire est remplacée à chaque frappe (le piano bouge pendant l'accord) ; une nouvelle note entre en mémoire quand elle est juste
    const known = c ? tunedRef.current[c.midi] !== undefined : false;
    if (c && !measRef.current && c.midi === S.midi && S.winF.length >= 3 && S.avg != null && (known || S.ok || Math.abs(S.avg) <= S.tol)) {
      const f0 = Math.exp(S.winF.reduce((a, x) => a + Math.log(x[1]), 0) / S.winF.length);
      setCfg(s => ({ ...s, tuned: { ...s.tuned, [c.midi]: { f0, B: c.B } } }));
    }
    const newStrike = e.state === 'attack' && (prevState.current !== 'attack' || e.rejected === 'retrigger');
    prevState.current = e.state;
    if (newStrike) { S.win = []; S.winF = []; S.trace = []; S.avg = null; }
    if (e.frame) {
      const f = e.frame, midi = f.note.midi;
      const Bnow = e.fused?.B ?? f.fit.B;
      const comb = combine(constraintsFor(midi, tunedRef.current, octRef.current, f.fit.f0, Bnow, f.fit.partials));
      const vCurve = f.note.cents - target.current(midi);
      const v = comb ? comb.cents : vCurve;
      // garde-fous : note déjà accordée qui a bougé, références qui se contredisent, cible loin de la courbe
      const mem = tunedRef.current[midi], tol = toleranceFor(midi, la4Ref.current);
      const drift = mem ? 1200 * Math.log2(f.fit.f0 / mem.f0) : 0;
      const warn: string[] = [];
      if (mem && Math.abs(drift) > tol) warn.push(`a bougé de ${drift > 0 ? '+' : '−'}${fmt(Math.abs(drift))} ct`);
      if (comb && comb.parts.length > 1 && comb.spread > 1.5) warn.push(`références en désaccord ±${fmt(comb.spread)} ct`);
      if (comb && Math.abs(vCurve - v) > 10) warn.push(`loin de la courbe (${vCurve - v > 0 ? '−' : '+'}${fmt(Math.abs(vCurve - v), 0)} ct)`);
      S.refLabel = [comb ? comb.label : 'courbe', ...warn].join(' · ');
      const mb = comb?.main.beatHz;
      S.beat = mb ?? null; S.beatName = mb != null ? comb!.main.label.split(' sur ')[0] : '';
      detail.current = { midi, parts: comb?.parts ?? [], cents: v, curve: vCurve, test: test3m6M(midi, { f0: f.fit.f0, B: Bnow }, tunedRef.current) };
      if (midi !== S.midi) { S.midi = midi; S.win = []; S.winF = []; S.trace = []; S.disp = v; S.ok = false; S.okTime = 0; setCurrent(midi); }
      if (S.disp == null) S.disp = v;
      S.meas = v; S.frozen = false; S.tol = toleranceFor(midi, la4Ref.current);
      S.win.push([e.time, v]);
      while (S.win.length && e.time - S.win[0][0] > 0.5) S.win.shift();
      S.winF.push([e.time, f.fit.f0]);
      while (S.winF.length && e.time - S.winF[0][0] > 0.5) S.winF.shift();
      const vals = S.win.map(x => x[1]), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      S.trace.push([e.time, avg]); while (S.trace.length && e.time - S.trace[0][0] > 2) S.trace.shift();
      S.avg = avg; S.sd = Math.sqrt(vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length);
    } else if (e.state === 'silent' || e.state === 'frozen') {
      if (S.midi != null) S.frozen = true;
    }
  }

  async function keepAwake() {
    try { wake.current = await navigator.wakeLock?.request('screen') ?? null; } catch { /* refusé : sans importance */ }
  }
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible' && sess.current) void keepAwake(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  async function start() {
    setErr('');
    try {
      const s = await startMicrophone(onEvent);
      s.processor.setTarget(undefined, cfg.la4);
      s.processor.setTracker(tracker.current);
      sess.current = s; setRunning(true); void keepAwake();
    } catch (e) { setErr('Micro refusé ou indisponible. Autorise le micro pour cette page puis réessaie. (' + String(e) + ')'); }
  }

  function setLa4(v: number) {
    v = Math.round(Math.min(470, Math.max(410, v)) * 10) / 10;
    setCfg(s => ({ ...s, la4: v }));
    sess.current?.processor.setTarget(undefined, v); tracker.current.setLa4(v);
  }

  function nudge(d: number) {
    const t = tracker.current, S = live.current;
    if (S.midi == null) return;
    if (t.current === undefined) t.setCurrent(S.midi);
    const to = t.nudge(d);
    if (to !== undefined) {
      // la lecture repart à la fenêtre suivante, attribuée à la bonne touche
      S.midi = to; setCurrent(to); S.win = []; S.winF = []; S.avg = null; S.disp = null; S.meas = null;
    }
  }

  function clearMeasures() { setCfg(s => ({ ...s, meas: {} })); setLastMeasured(null); }
  function newPiano() { setCfg(s => ({ ...s, meas: {}, tuned: {} })); setLastMeasured(null); }

  const nMeas = Object.keys(cfg.meas).length, nTuned = Object.keys(cfg.tuned).length;
  const tunedDev = useMemo(() => Object.fromEntries(Object.entries(cfg.tuned).map(([m, n]) => [m, 1200 * Math.log2(partial(n, 1) / (cfg.la4 * Math.pow(2, (Number(m) - 69) / 12)))])), [cfg.tuned, cfg.la4]);
  const doneQuick = QUICK.filter(m => cfg.meas[m]).length;
  const curDev = current != null ? dev[current] + cfg.offset : null;

  return (
    <main className="mx-auto flex h-dvh max-w-xl flex-col select-none bg-[#0b0e12] text-[#e8edf3]" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="flex items-center gap-2 px-4 pt-3">
        <button className={pill} onClick={() => setSheet('hz')}>
          La {fmt(cfg.la4)} Hz{cfg.offset ? <span className="text-[#7d8795]"> · {cfg.offset > 0 ? '+' : '−'}{Math.abs(cfg.offset)} ct</span> : null}
        </button>
        <button className={pill + ' min-w-0 truncate'} onClick={() => setSheet('piano')}>
          {profile.label} · {OCTAVES.find(o => o.id === cfg.oct)!.label}
        </button>
        <button className={pill + ' ml-auto ' + (measuring ? '!bg-[#74deae] !text-[#0b0e12] !border-[#74deae]' : '')} onClick={() => setMeasuring(m => !m)}>
          {measuring ? 'Mesure…' : 'Mesurer B'}
        </button>
      </header>

      <section className="relative min-h-[240px] flex-[1.25]" onClick={() => running && setShowDetail(d => !d)}>
        <Strobe live={live} />
        {current != null && <>
          <button aria-label="Demi-ton plus bas" onClick={ev => { ev.stopPropagation(); nudge(-1); }} className="absolute left-2 top-[14%] h-16 w-14 text-3xl text-[#3a4450] active:text-[#e8edf3]">‹</button>
          <button aria-label="Demi-ton plus haut" onClick={ev => { ev.stopPropagation(); nudge(1); }} className="absolute right-2 top-[14%] h-16 w-14 text-3xl text-[#3a4450] active:text-[#e8edf3]">›</button>
        </>}
        {!running && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0e12]/85 px-6 text-center">
            <button onClick={start} className="rounded-full bg-[#74deae] px-8 py-4 text-lg font-semibold text-[#0b0e12] active:opacity-80">Écouter</button>
            <p className="text-sm text-[#7d8795]">Une corde à la fois, bande de feutre en place.</p>
            {err && <p className="text-sm text-[#ef8b5b]">{err}</p>}
          </div>
        )}
      </section>

      <section className="flex-1 px-4 pb-3">
        {showDetail && !measuring ? <DetailPanel detail={detail} onClose={() => setShowDetail(false)} /> : measuring ? (
          <div className="mb-2">
            <p className="text-sm">Joue chaque note proposée <b>2 fois</b>, forte, laisse sonner 2 s. {doneQuick}/{QUICK.length}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK.map(m => {
                const v = cfg.meas[m], b = v && medianB(v), bad = b && isOutlier(profile, m, b);
                return <span key={m} className={'rounded-md px-2 py-1 text-xs tabular-nums ' + (v ? (bad ? 'bg-[#2a1d16] text-[#ef8b5b]' : 'bg-[#16302a] text-[#74deae]') : 'bg-[#12161c] text-[#7d8795]')}>
                  {frLabel(m)} ({m - 20}){v ? ` · ${fmt(b! * 1000, 2)} (${v.length})` : ''}
                </span>;
              })}
            </div>
            <p className="mt-1.5 h-4 text-xs text-[#7d8795]">
              {lastMeasured != null && cfg.meas[lastMeasured] ? `${frLabel(lastMeasured)} : B = ${fmt(medianB(cfg.meas[lastMeasured]) * 1000, 2)}×10⁻³ · d'autres notes affinent aussi` : 'Toute autre note jouée est aussi prise en compte.'}
            </p>
          </div>
        ) : (
          <div className="mb-1 flex items-center gap-3 text-xs">
            {(['accord', 'B'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={'py-1 whitespace-nowrap ' + (view === v ? 'text-[#e8edf3] border-b border-[#74deae]' : 'text-[#7d8795]')}>
                {v === 'accord' ? "Courbe d'accord" : 'Inharmonicité'}
              </button>
            ))}
            <span className="ml-auto text-[#7d8795] tabular-nums">
              {nTuned ? `${nTuned} en mémoire` : current != null && curDev != null ? `${frLabel(current)} (${current - 20}) visé ${curDev >= 0 ? '+' : '−'}${fmt(Math.abs(curDev))} ct` : 'Commence par le La4'}
            </span>
          </div>
        )}
        {!(showDetail && !measuring) && <Curve view={measuring ? 'B' : view} dev={dev.map(d => d + cfg.offset)} B={B} profileB={Bp} profile={profile} meas={cfg.meas} tunedDev={tunedDev}
          current={current} suggested={measuring ? QUICK : []} />}
        {measuring && (
          <div className="mt-2 flex gap-2">
            <button className={chip} onClick={() => setMeasuring(false)}>Terminé</button>
            <button className={chip + ' text-[#7d8795]'} onClick={clearMeasures} disabled={!nMeas}>Effacer les mesures</button>
          </div>
        )}
      </section>

      {sheet && <div className="fixed inset-0 bg-black/50" onClick={() => setSheet('')} />}
      {sheet === 'hz' && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-xl rounded-t-2xl border-t border-[#222a34] bg-[#12161c] p-4 pb-8">
          <h3 className="mb-3 font-semibold">Diapason</h3>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#7d8795]">La4</span>
            <span className="flex items-center gap-2">
              <button className={chip + ' w-11'} onClick={() => setLa4(cfg.la4 - 0.1)}>−</button>
              <output className="w-24 text-center tabular-nums">{fmt(cfg.la4)} Hz</output>
              <button className={chip + ' w-11'} onClick={() => setLa4(cfg.la4 + 0.1)}>+</button>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-6 gap-1.5">
            {PRESETS_HZ.map(h => <button key={h} className={chip + ' px-0 ' + (cfg.la4 === h ? '!border-[#74deae] text-[#74deae]' : '')} onClick={() => setLa4(h)}>{h}</button>)}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-[#7d8795]">Décalage global</span>
            <span className="flex items-center gap-2">
              <button className={chip + ' w-11'} onClick={() => setCfg(s => ({ ...s, offset: s.offset - 1 }))}>−</button>
              <output className="w-24 text-center tabular-nums">{cfg.offset > 0 ? '+' : cfg.offset < 0 ? '−' : ''}{Math.abs(cfg.offset)} ct</output>
              <button className={chip + ' w-11'} onClick={() => setCfg(s => ({ ...s, offset: s.offset + 1 }))}>+</button>
            </span>
          </div>
          <p className="mt-3 text-xs text-[#7d8795]">Pas de 0,1 Hz et de 1 ct. Le décalage s'ajoute à toute la courbe d'accord.</p>
        </div>
      )}
      {sheet === 'piano' && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-h-[85dvh] max-w-xl overflow-y-auto rounded-t-2xl border-t border-[#222a34] bg-[#12161c] p-4 pb-8">
          <h3 className="mb-2 font-semibold">Type de piano</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {PROFILES.map(p => (
              <button key={p.id} onClick={() => setCfg(s => ({ ...s, profile: p.id }))}
                className={chip + ' text-left ' + (p.id === profile.id ? '!border-[#74deae]' : '')}>
                {p.label}<span className="block text-xs text-[#7d8795]">{p.sub}</span>
              </button>
            ))}
          </div>
          <h3 className="mb-2 mt-4 font-semibold">Octaves</h3>
          <div className="grid grid-cols-4 gap-1.5">
            {OCTAVES.map(o => (
              <button key={o.id} onClick={() => setCfg(s => ({ ...s, oct: o.id }))}
                className={chip + ' px-1 ' + (o.id === cfg.oct ? '!border-[#74deae] text-[#74deae]' : '')}>{o.label}</button>
            ))}
          </div>
          <p className="mt-1 text-xs text-[#7d8795]">{OCTAVES.find(o => o.id === cfg.oct)!.sub}. Sert à viser chaque octave sur la note déjà accordée.</p>
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-xs text-[#7d8795]">{nTuned} note{nTuned > 1 ? 's' : ''} accordée{nTuned > 1 ? 's' : ''} en mémoire sur ce piano. À effacer en changeant de piano.</p>
            <button className={chip + ' shrink-0'} onClick={newPiano} disabled={!nMeas && !nTuned}>Nouveau piano</button>
          </div>
          <p className="mt-4 text-[11px] text-[#3a4450]">Accordeur Pro {VERSION}</p>
        </div>
      )}
    </main>
  );
}

/** Détail de la cible (touche le stroboscope) : chaque intervalle avec une note accordée, son écart et son poids. */
function DetailPanel({ detail, onClose }: { detail: React.RefObject<Detail | null>; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(detail.current);
  useEffect(() => { const id = setInterval(() => setD(detail.current ? { ...detail.current } : null), 250); return () => clearInterval(id); }, [detail]);
  const sgn = (v: number) => (v >= 0 ? '+' : '−') + fmt(Math.abs(v)) + ' ct';
  return (
    <div className="text-sm" onClick={onClose}>
      <p className="mb-2 text-xs text-[#7d8795]">Chaque ligne : où en est la note pour cet intervalle seul. Les octaves décident (compromis pondéré) ; quintes, quartes et douzièmes servent de contrôle. Touche pour fermer.</p>
      {!d ? <p className="text-[#7d8795]">Joue une note.</p> : <>
        <div className="flex justify-between border-b border-[#222a34] pb-1 font-semibold"><span>{noteLabel(d.midi)} ({d.midi - 20}) · compromis</span><span className="tabular-nums">{sgn(d.cents)}</span></div>
        {d.parts.length === 0 && <p className="py-1 text-[#7d8795]">Aucune note accordée à l'octave, la quinte, la quarte, la douzième ou la double octave : la courbe sert de repère.</p>}
        {[...d.parts].sort((a, b) => b.weight - a.weight).map((c, i) => (
          <div key={i} className="flex justify-between py-0.5 tabular-nums">
            <span className={c.used ? 'text-[#c3cad3]' : 'text-[#7d8795]'}>{c.label} <span className="text-[#3a4450]">{c.used ? '×' + fmt(c.weight, 2) : 'contrôle'}</span></span>
            <span className={Math.abs(c.cents - d.cents) > 3 ? 'text-[#ef8b5b]' : ''}>{sgn(c.cents)}</span>
          </div>
        ))}
        <div className="flex justify-between py-0.5 text-[#7d8795] tabular-nums"><span>courbe (repère)</span><span>{sgn(d.curve)}</span></div>
        {d.test && (
          <div className="mt-2 rounded-lg bg-[#12161c] p-2">
            <p className="text-xs text-[#7d8795]">Test 3m + 6M · {noteLabel(d.midi)}–{noteLabel(d.test.mid)} et {noteLabel(d.test.mid)}–{noteLabel(d.test.hi)}</p>
            <p className="tabular-nums">3m {fmt(d.test.m3)} b/s · 6M {fmt(d.test.M6)} b/s</p>
          </div>
        )}
      </>}
    </div>
  );
}
