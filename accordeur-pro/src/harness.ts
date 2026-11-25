/* Banc d'essai : analyse un fichier audio (ou un signal de test) avec le moteur DSP de l'étape 1. */
import { AudioProcessor } from './dsp/audioProcessor';
import { centsBetween, midiToFreq } from './dsp/inharmonicityEngine';
import { noteName } from './dsp/tuningCurve';
import type { ProcessorEvent } from './dsp/types';
import { createDial, DIAL_CSS } from './ui/dial';
import { scenario, whiteNoise, concat, add, tones, SR } from './dsp/__tests__/synth';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const sel = $('note') as HTMLSelectElement;
for (let m = 21; m <= 108; m++) { const o = document.createElement('option'); o.value = String(m); o.textContent = noteName(m) + '  (' + m + ')'; sel.appendChild(o); }
sel.value = '57';
const la4 = () => Math.min(470, Math.max(410, parseFloat(($('la4') as HTMLInputElement).value) || 440));
const auto = () => ($('auto') as HTMLInputElement).checked;

function nearestMidi(f: number): number { return Math.round(69 + 12 * Math.log2(f / la4())); }

let last: { sig: Float32Array; events: ProcessorEvent[] } | null = null;

async function analyse(sig: Float32Array, titre: string) {
  const out = $('res'); out.innerHTML = '<p class="muted">Analyse de « ' + titre + ' » (' + (sig.length / SR).toFixed(1) + ' s)…</p>';
  const proc = new AudioProcessor({ sampleRate: SR });
  proc.setTarget(auto() ? undefined : parseInt(sel.value, 10), la4());
  const events: ProcessorEvent[] = [];
  for (let i = 0; i < sig.length; i += SR) {            // 1 s d'audio par tour, pour laisser respirer l'interface
    for (let j = i; j < Math.min(sig.length, i + SR); j += 2048) events.push(...proc.push(sig.subarray(j, Math.min(sig.length, i + SR, j + 2048))));
    await new Promise(r => setTimeout(r, 0));
  }
  last = { sig, events };
  render(events, titre);
  ($('player') as HTMLElement).hidden = false;
  stopReplay(); setDial(null);
}

function render(events: ProcessorEvent[], titre: string) {
  const out = $('res');
  const fused = [...events].reverse().find(e => e.fused)?.fused;
  const frames = events.filter(e => e.frame);
  const reasons: Record<string, number> = {};
  events.forEach(e => { if (e.rejected) reasons[e.rejected] = (reasons[e.rejected] || 0) + 1; });
  const rms = events.map(e => e.rmsDb), floor = events.length ? events[events.length - 1].noiseFloorDb : NaN;
  const states = ['silent', 'attack', 'sustain', 'frozen'].map(s => s + ' ' + events.filter(e => e.state === s).length).join(' · ');
  let h = '<h2>' + titre + '</h2>';
  if (fused) {
    const m = auto() ? nearestMidi(fused.f0) : parseInt(sel.value, 10), et = midiToFreq(m, la4());
    const dev = centsBetween(fused.f0, et);
    h += '<div class="big">' + fused.f0.toFixed(3) + ' Hz</div>' +
      '<p>Fondamentale virtuelle de <b>' + noteName(m) + '</b> : ' + (dev >= 0 ? '+' : '') + dev.toFixed(2) + ' ct par rapport au tempérament égal (La4 = ' + la4() + ' Hz). ' +
      'Incertitude ±' + fused.sigmaF0Cents.toFixed(2) + ' ct sur ' + fused.frames + ' fenêtres.</p>' +
      '<p>Inharmonicité <b>B = ' + fused.B.toExponential(2) + '</b>. Pic k=1 ' + (fused.fundamentalUsed ? 'utilisé' : 'absent ou ignoré') + '.</p>';
    const best = frames.map(e => e.frame!).sort((a, b) => b.fit.partials.length - a.fit.partials.length)[0];
    if (best) {
      h += '<h3>Partiels de la meilleure fenêtre (cohérence ' + (best.fit.coherence * 100).toFixed(0) + ' %, écart rms ' + best.fit.rmsCents.toFixed(2) + ' ct)</h3><div class="scroll"><table><tr><th>k</th><th>Fréquence</th><th>Niveau</th><th>S/B</th><th>Écart au modèle</th><th>Poids</th></tr>' +
        best.fit.partials.map(p => '<tr><td>' + p.k + '</td><td>' + p.freq.toFixed(2) + ' Hz</td><td>' + p.magDb.toFixed(0) + ' dB</td><td>' + p.snrDb.toFixed(0) + ' dB</td><td>' + (p.residualCents >= 0 ? '+' : '') + p.residualCents.toFixed(2) + ' ct</td><td>' + p.weight.toFixed(2) + '</td></tr>').join('') + '</table></div>';
    }
  } else {
    h += '<div class="big no">Aucune mesure</div><p>Le détecteur n’a retenu aucune fenêtre : pas de note détectée, ou signal rejeté (bruit, voix…).</p>';
  }
  h += '<h3>Diagnostic</h3><p class="muted">Fenêtres retenues : ' + frames.length + '. Rejets : ' + (Object.keys(reasons).length ? Object.entries(reasons).map(([k, v]) => k + ' ×' + v).join(', ') : 'aucun') +
    '.<br>Blocs de 5 ms par état : ' + states + '.<br>Niveau max ' + (rms.length ? Math.max(...rms).toFixed(0) : '—') + ' dBFS · plancher de bruit ' + floor.toFixed(0) + ' dBFS.</p>';
  out.innerHTML = h;
}

// --- fichier audio ---
($('file') as HTMLInputElement).addEventListener('change', async ev => {
  const f = (ev.target as HTMLInputElement).files?.[0]; if (!f) return;
  try {
    const ctx = new AudioContext({ sampleRate: SR });
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < buf.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    void ctx.close();
    // 1 s de silence (plancher de bruit) avant le fichier si celui-ci démarre direct sur la note : le détecteur apprend le fond pendant les 0,5 premières secondes
    const lead = ($('lead') as HTMLInputElement).checked ? new Float32Array(SR * 0.6) : new Float32Array(0);
    await analyse(concat(lead, mono, new Float32Array(SR * 1.5)), f.name);
  } catch (e) { $('res').innerHTML = '<p class="no">Impossible de lire ce fichier : ' + String(e) + '</p>'; }
});

// --- signaux de test ---
$('t-a0').addEventListener('click', () => {
  sel.value = '21'; ($('auto') as HTMLInputElement).checked = false;
  void analyse(scenario({ f0: 27.5 * Math.pow(2, -6 / 1200), B: 1.2e-3, kMin: 2, kMax: 14, dur: 3.5 }, { seed: 3 }).signal, 'La0 synthétique, k=1 absent, B = 1,2e-3 (f0 vraie : 27,4048 Hz, −6 ct)');
});
$('t-bruit').addEventListener('click', () => {
  ($('auto') as HTMLInputElement).checked = false;
  void analyse(concat(whiteNoise(1, 3e-4, 2), whiteNoise(5, 0.1, 3), whiteNoise(2, 3e-4, 4)), 'Rafale de bruit blanc fort');
});
$('t-hum').addEventListener('click', () => {
  sel.value = '21'; ($('auto') as HTMLInputElement).checked = false;
  const { signal } = scenario({ f0: 27.5 * Math.pow(2, -4 / 1200), B: 1e-3, kMin: 2, kMax: 14, dur: 3.5 }, { seed: 6, noise: 2e-3 });
  const n = signal.length / SR;
  void analyse(add(add(signal, tones(n, [50, 100, 150, 200, 250], 0.01)), tones(n, [185, 370, 555, 740, 925, 1110], 0.02)), 'La0 + ronflement 50 Hz + voix (f0 vraie : 27,4126 Hz)');
});

// --- micro (utile seulement hors de cette page : un navigateur normal sur https) ---
$('t-mic').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    stream.getTracks().forEach(t => t.stop());
    $('res').innerHTML = '<p>Micro accessible. Cette page analyse des fichiers ; l’écoute en direct est dans l’application complète.</p>';
  } catch { $('res').innerHTML = '<p class="no">Micro bloqué dans cette page (cadre protégé). Enregistre ta note avec le magnétophone du téléphone et charge le fichier ci-dessus.</p>'; }
});

// --- cadran + relecture synchronisée ---
const st = document.createElement('style'); st.textContent = DIAL_CSS; document.head.appendChild(st);
const dial = createDial($('dial'));
const tol = () => parseFloat(($('tol') as HTMLSelectElement).value);
let shown: { note: string; cents: number; hz: number; B: number; frozen: boolean } | null = null;
function setDial(v: typeof shown) {
  shown = v;
  dial.update({ note: v ? v.note : null, cents: v ? v.cents : null, hz: v?.hz, tolerance: tol(), frozen: v?.frozen, detail: v ? 'B ' + v.B.toExponential(2) : undefined });
}
$('tol').addEventListener('change', () => setDial(shown));
let raf = 0, src: AudioBufferSourceNode | null = null, rctx: AudioContext | null = null;
function stopReplay() { cancelAnimationFrame(raf); try { src?.stop(); } catch { /* déjà arrêtée */ } src = null; void rctx?.close(); rctx = null; $('play').textContent = '▶ Rejouer avec le cadran'; }
$('play').addEventListener('click', () => {
  if (src) { stopReplay(); return; }
  if (!last) return;
  const { sig, events } = last;
  rctx = new AudioContext({ sampleRate: SR });
  const buf = rctx.createBuffer(1, sig.length, SR); buf.getChannelData(0).set(sig);
  src = rctx.createBufferSource(); src.buffer = buf; src.connect(rctx.destination);
  const t0 = rctx.currentTime + 0.1; src.start(t0); $('play').textContent = '■ Arrêter';
  src.onended = () => { if (src) stopReplay(); };
  let i = 0; setDial(null);
  const tick = () => {
    if (!rctx) return;
    const t = rctx.currentTime - t0;
    while (i < events.length && events[i].time <= t) {
      const e = events[i++];
      if (e.state === 'silent') continue;
      if (e.state === 'attack' && !e.fused && !e.frame) setDial(null);
      if (e.frame) setDial({ note: e.frame.note.name, cents: e.frame.note.cents, hz: e.frame.fit.f0, B: e.frame.fit.B, frozen: false });
      else if (e.frozenNow && e.fused) setDial({ note: e.fused.note.name, cents: e.fused.note.cents, hz: e.fused.f0, B: e.fused.B, frozen: true });
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
});
setDial(null);
