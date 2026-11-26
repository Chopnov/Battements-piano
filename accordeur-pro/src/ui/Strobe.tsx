import { useEffect, useRef } from 'react';
import { frName } from '../tuning/stretch';

/** État vivant du stroboscope, écrit par le flux audio et lu à chaque image (pas de rendu React). */
export interface LiveState {
  midi: number | null;
  /** Dernière lecture (cents par rapport à la cible) */
  meas: number | null;
  /** Lecture lissée affichée */
  disp: number | null;
  /** Fenêtre de 0,9 s : [temps audio, cents] */
  win: [number, number][];
  avg: number | null;
  sd: number;
  frozen: boolean;
  tol: number;
  ok: boolean;
  okTime: number;
  okAnim: number;
  flash: number;
  off: number;
  /** Note tenue sous le micro en mode mesure (pas de juste/faux) */
  measuring: boolean;
}

export const newLive = (): LiveState => ({
  midi: null, meas: null, disp: null, win: [], avg: null, sd: 0, frozen: false, tol: 1,
  ok: false, okTime: 0, okAnim: 0, flash: 0, off: 0, measuring: false,
});

const C = { bg: '#0b0e12', surface: '#12161c', line: '#222a34', fg: '#e8edf3', muted: '#7d8795', dim: '#3a4450', accent: '#74deae' };
const FD = '"Sora", "Inter", system-ui, -apple-system, sans-serif', FB = '"Inter", system-ui, -apple-system, sans-serif';
const hex = (h: string) => [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16));
const mix = (a: string, b: string, t: number) => { const pa = hex(a), pb = hex(b); return `rgb(${pa.map((x, i) => Math.round(x + (pb[i] - x) * t)).join(',')})`; };
const alpha = (h: string, a: number) => { const p = hex(h); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; };
const fmt = (v: number, d: number) => v.toFixed(d).replace('.', ',');
const centsText = (c: number) => { const a = Math.abs(c); return (a < 0.05 ? '' : c > 0 ? '+' : '−') + (a < 10 ? fmt(a, 1) : fmt(a, 0)) + ' ct'; };
const prox = (c: number, t: number) => { const W = 8 * t; return Math.max(0, Math.min(1, (W - Math.abs(c)) / (W - t))); };

/** Avance l'état d'un pas dt (s) : lissage, juste avec hystérésis (entrée ±tol, sortie ±1,6 tol), défilement. */
function step(S: LiveState, dt: number) {
  if (S.meas != null && S.disp != null && !S.frozen) S.disp += (S.meas - S.disp) * (1 - Math.exp(-dt / 0.12));
  const wasOk = S.ok, T = S.tol, m = S.avg;
  if (S.measuring || m == null) { S.ok = false; S.okTime = 0; }
  else if (!S.frozen) {
    const hold = S.midi != null && S.midi >= 91 ? 0.12 : 0.35;      // aigus : on accorde sur l'attaque
    if (!S.ok) { S.okTime = Math.abs(m) <= T ? S.okTime + dt : 0; S.ok = S.okTime >= hold; }
    else if (Math.abs(m) > 1.6 * T) { S.ok = false; S.okTime = 0; }
  }
  if (S.ok && !wasOk) { S.flash = 1; navigator.vibrate?.(25); }
  S.okAnim += ((S.ok ? 1 : 0) - S.okAnim) * (1 - Math.exp(-dt / 0.12));
  S.flash *= Math.exp(-dt / 0.45);
  if (S.disp != null && !S.frozen) S.off += Math.max(-50, Math.min(50, S.disp)) * 5.2 * dt * (S.ok ? 0.6 : 1);
}

function band(ctx: CanvasRenderingContext2D, x: number, y: number, bw: number, bh: number, off: number, period: number, col: string) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, bw, bh, Math.min(10, bh / 2)); ctx.clip();
  ctx.fillStyle = C.surface; ctx.fillRect(x, y, bw, bh); ctx.fillStyle = col;
  const o = ((off % period) + period) % period, bwid = Math.min(period * 0.42, 18);
  for (let px = x - period + o; px < x + bw + period; px += period) { ctx.beginPath(); ctx.roundRect(px, y + bh * 0.18, bwid, bh * 0.64, 2); ctx.fill(); }
  const g = ctx.createLinearGradient(x, 0, x + bw, 0);
  g.addColorStop(0, alpha(C.bg, 1)); g.addColorStop(0.15, alpha(C.bg, 0)); g.addColorStop(0.85, alpha(C.bg, 0)); g.addColorStop(1, alpha(C.bg, 1));
  ctx.fillStyle = g; ctx.fillRect(x, y, bw, bh); ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, S: LiveState) {
  ctx.clearRect(0, 0, w, h);
  const c = S.disp;
  const live = S.frozen || c == null ? C.dim : S.measuring ? C.fg : mix(C.fg, C.accent, Math.max(0.5 * Math.pow(prox(c, S.tol), 1.6), S.okAnim));
  // note
  const ns = Math.min(w * 0.2, h * 0.3), ny = h * 0.33;
  ctx.textBaseline = 'alphabetic';
  if (S.midi == null) { ctx.fillStyle = C.dim; ctx.font = `300 ${ns}px ${FD}`; ctx.textAlign = 'center'; ctx.fillText('—', w / 2, ny); }
  else {
    const n = frName(S.midi);
    ctx.font = `500 ${ns}px ${FD}`; const wN = ctx.measureText(n.name).width;
    ctx.font = `300 ${ns * 0.42}px ${FD}`; const wO = ctx.measureText(String(n.oct)).width;
    const x0 = w / 2 - (wN + wO + ns * 0.04) / 2;
    ctx.textAlign = 'left'; ctx.fillStyle = S.frozen ? C.muted : C.fg; ctx.font = `500 ${ns}px ${FD}`; ctx.fillText(n.name, x0, ny);
    ctx.fillStyle = C.muted; ctx.font = `300 ${ns * 0.42}px ${FD}`; ctx.fillText(String(n.oct), x0 + wN + ns * 0.04, ny);
  }
  // bande
  const bw = w * 0.9, bx = (w - bw) / 2, bh = Math.max(34, h * 0.16), by = h * 0.45;
  const glow = S.frozen ? 0 : Math.max(S.flash, 0.55 * S.okAnim);
  if (glow > 0.02) {
    ctx.save(); ctx.shadowColor = alpha(C.accent, 0.9 * glow); ctx.shadowBlur = 8 + 26 * glow; ctx.strokeStyle = alpha(C.accent, 0.85 * glow); ctx.lineWidth = 2;
    const pad = 6 + 8 * S.flash; ctx.beginPath(); ctx.roundRect(bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad, 12 + pad); ctx.stroke();
    ctx.fillStyle = alpha(C.accent, 0.06 * glow); ctx.fill(); ctx.restore();
  }
  band(ctx, bx, by, bw, bh, S.off, bw / 6, live);
  ctx.fillStyle = S.okAnim > 0.5 ? C.accent : C.muted;
  ctx.beginPath(); ctx.moveTo(w / 2 - 5, by - 9); ctx.lineTo(w / 2 + 5, by - 9); ctx.lineTo(w / 2, by - 3); ctx.closePath(); ctx.fill();
  // cents et état
  const cs = Math.max(16, Math.min(w * 0.065, h * 0.09)), cy = by + bh + cs * 1.7;
  ctx.textAlign = 'center'; ctx.font = `500 ${cs}px ${FB}`; ctx.fillStyle = live;
  if (c != null) ctx.fillText(centsText(c), w / 2, cy);
  ctx.font = `400 ${cs * 0.7}px ${FB}`;
  ctx.fillStyle = S.frozen ? C.dim : S.okAnim > 0.5 ? C.accent : C.muted;
  const unstable = S.ok && S.sd > 0.7 * S.tol;
  const msg = S.midi == null ? 'joue une note' : S.frozen ? 'figé' : S.measuring ? 'mesure…'
    : S.okAnim > 0.5 ? (unstable ? `juste · note instable ±${fmt(S.sd * 1.4, 1)} ct` : 'juste') : c != null && Math.abs(c) > 50 ? 'hors cadran' : '';
  ctx.fillText(msg, w / 2, cy + cs * 1.3);
}

export function Strobe({ live }: { live: React.RefObject<LiveState> }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current!, ctx = el.getContext('2d')!;
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const dpr = window.devicePixelRatio || 1, r = el.getBoundingClientRect();
      if (el.width !== Math.round(r.width * dpr) || el.height !== Math.round(r.height * dpr)) { el.width = Math.round(r.width * dpr); el.height = Math.round(r.height * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      step(live.current, dt);
      draw(ctx, r.width, r.height, live.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [live]);
  return <canvas ref={cv} className="block w-full h-full" />;
}
