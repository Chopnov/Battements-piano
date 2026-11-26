import { frLabel, isOutlier, medianB, type Measures, type PianoProfile } from '../tuning/stretch';

interface Props {
  view: 'accord' | 'B';
  dev: number[];
  B: number[];
  profileB: number[];
  profile: PianoProfile;
  meas: Measures;
  current: number | null;
  /** Touches proposées pour la mesure (anneaux) */
  suggested?: number[];
}

const W = 340, H = 150, L = 30, R = 8, T = 10, Bt = 22;
const X = (m: number) => L + ((m - 21) / 87) * (W - L - R);

/** Courbe d'accord (Railsback : écart au tempérament égal) ou B en échelle linéaire, avec les notes mesurées. */
export function Curve({ view, dev, B, profileB, profile, meas, current, suggested = [] }: Props) {
  const keys = Array.from({ length: 88 }, (_, i) => 21 + i);
  const measured = Object.entries(meas).map(([m, v]) => ({ m: Number(m), B: medianB(v) }));
  let ys: number[], lo: number, hi: number, ticks: number[], unit: string;
  if (view === 'accord') {
    ys = keys.map(m => dev[m]);
    lo = Math.min(-10, Math.floor(Math.min(...ys) / 10) * 10); hi = Math.max(10, Math.ceil(Math.max(...ys) / 10) * 10);
    ticks = []; for (let v = lo; v <= hi; v += 10) ticks.push(v);
    unit = 'ct';
  } else {
    ys = keys.map(m => B[m] * 1000);
    const top = Math.max(...ys, ...measured.map(p => p.B * 1000));
    const stepv = top > 20 ? 10 : top > 8 ? 5 : top > 4 ? 2 : 1;
    lo = 0; hi = Math.ceil(top / stepv) * stepv; ticks = []; for (let v = 0; v <= hi; v += stepv) ticks.push(v);
    unit = 'B ×10⁻³';
  }
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - Bt);
  const path = keys.map((m, i) => `${i ? 'L' : 'M'}${X(m).toFixed(1)} ${Y(ys[i]).toFixed(1)}`).join(' ');
  const prof = view === 'B' ? keys.map((m, i) => `${i ? 'L' : 'M'}${X(m).toFixed(1)} ${Y(profileB[m] * 1000).toFixed(1)}`).join(' ') : '';
  const yOf = (m: number, b: number) => (view === 'accord' ? Y(dev[m]) : Y(b * 1000));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={view === 'accord' ? "Courbe d'accord" : 'Inharmonicité'}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? '#3a4450' : '#1a2029'} strokeWidth={1} />
          <text x={L - 4} y={Y(v) + 3} fontSize={9} fill="#7d8795" textAnchor="end">{v > 0 && view === 'accord' ? '+' + v : v}</text>
        </g>
      ))}
      <text x={L} y={H - 2} fontSize={9} fill="#7d8795">{unit}</text>
      {[24, 36, 48, 60, 72, 84, 96, 108].map(m => (
        <text key={m} x={X(m)} y={H - 10} fontSize={9} fill="#7d8795" textAnchor="middle">{'Do' + (Math.floor(m / 12) - 1)}</text>
      ))}
      <line x1={X(profile.brk + 20) + 2} x2={X(profile.brk + 20) + 2} y1={T} y2={H - Bt} stroke="#222a34" strokeDasharray="2 3" />
      {prof && <path d={prof} fill="none" stroke="#3a4450" strokeWidth={1.2} strokeDasharray="3 3" />}
      <path d={path} fill="none" stroke="#e8edf3" strokeWidth={1.6} />
      {suggested.filter(m => !meas[m]).map(m => (
        <circle key={'s' + m} cx={X(m)} cy={yOf(m, B[m])} r={4} fill="none" stroke="#7d8795" strokeWidth={1.2} />
      ))}
      {measured.map(p => {
        const bad = isOutlier(profile, p.m, p.B);
        return <circle key={p.m} cx={X(p.m)} cy={yOf(p.m, p.B)} r={3.4} fill={bad ? 'none' : '#74deae'} stroke={bad ? '#ef8b5b' : 'none'} strokeWidth={1.4}>
          <title>{frLabel(p.m)} · B {(p.B * 1000).toFixed(2)}×10⁻³{bad ? ' · douteuse, écartée' : ''}</title>
        </circle>;
      })}
      {current != null && <line x1={X(current)} x2={X(current)} y1={T} y2={H - Bt} stroke="#74deae" strokeOpacity={0.5} />}
    </svg>
  );
}
