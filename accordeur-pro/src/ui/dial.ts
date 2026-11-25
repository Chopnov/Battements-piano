/** Cadran d'accord (style PT-A1 / Pianometer) : aiguille sur ±50 ct, zone verte, note détectée en grand. */

export interface DialState {
  /** Nom de la note détectée (ex. « La3 »), ou null s'il n'y a pas de mesure */
  note: string | null;
  /** Écart en cents (positif = trop haut). null = pas de mesure */
  cents: number | null;
  hz?: number | null;
  /** Texte secondaire (ex. B) */
  detail?: string;
  /** true = mesure figée après la fin du son */
  frozen?: boolean;
  /** Demi-largeur de la zone « juste » en cents */
  tolerance: number;
}

const RANGE = 50, SWEEP = 68; // ±50 ct sur ±68°
const CX = 160, CY = 160, R = 130;

const pt = (ct: number, r: number) => {
  const a = ((ct / RANGE) * SWEEP * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
};
const arc = (c0: number, c1: number, r: number) => {
  const [x0, y0] = pt(c0, r), [x1, y1] = pt(c1, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export const DIAL_CSS = `
.dial{--d-ok:#2fd27a;--d-warn:#f0b429;--d-bad:#ef5b5b;--d-fg:#e8ecf2;--d-mut:#8e99a8;--d-line:#2a3340;display:block;width:100%;max-width:420px;margin:0 auto;color:var(--d-fg);font-family:Inter,system-ui,sans-serif}
.dial svg{width:100%;height:auto;display:block}
.dial .needle{transform-origin:160px 160px;transition:transform .18s ease-out}
.dial .tick{stroke:var(--d-mut);stroke-width:1.5}.dial .lab{fill:var(--d-mut);font-size:11px;text-anchor:middle}
.dial .note{font-size:46px;font-weight:700;text-anchor:middle;fill:var(--d-fg)}
.dial .cents{font-size:20px;font-weight:600;text-anchor:middle;font-variant-numeric:tabular-nums}
.dial .sub{font-size:12px;text-anchor:middle;fill:var(--d-mut);font-variant-numeric:tabular-nums}
.dial .hint{font-size:13px;font-weight:600;text-anchor:middle}
.dial[data-s=ok] .glow{opacity:1}.dial .glow{opacity:0;transition:opacity .2s}
.dial[data-s=off] .needle{opacity:.25}
`;

export function createDial(host: HTMLElement) {
  host.classList.add('dial');
  const zones = [
    [-RANGE, -8, 'var(--d-bad)'], [-8, -0, 'var(--d-warn)'], [0, 8, 'var(--d-warn)'], [8, RANGE, 'var(--d-bad)'],
  ] as const;
  let svg = `<svg viewBox="0 0 320 250" role="img" aria-label="Cadran d'accord">
  <g id="zones">${zones.map(z => `<path d="${arc(z[0], z[1], R)}" stroke="${z[2]}" stroke-width="12" fill="none" opacity=".35"/>`).join('')}</g>
  <path id="okzone" d="" stroke="var(--d-ok)" stroke-width="14" fill="none"/>
  <circle class="glow" cx="160" cy="160" r="150" fill="none" stroke="var(--d-ok)" stroke-width="3"/>`;
  for (let c = -50; c <= 50; c += 10) {
    const [x0, y0] = pt(c, R - 10), [x1, y1] = pt(c, R - (c % 50 === 0 || c === 0 ? 26 : 20)), [lx, ly] = pt(c, R - 38);
    svg += `<line class="tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
    if (c % 25 === 0) svg += `<text class="lab" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${c > 0 ? '+' : ''}${c}</text>`;
  }
  svg += `<g class="needle" id="needle"><line x1="160" y1="160" x2="160" y2="40" stroke="var(--d-fg)" stroke-width="3" stroke-linecap="round"/><circle cx="160" cy="160" r="7" fill="var(--d-fg)"/></g>
  <text class="note" id="dnote" x="160" y="212">—</text>
  <text class="cents" id="dcents" x="160" y="236"> </text>
  <text class="hint" id="dhint" x="160" y="22"> </text>
  <text class="sub" id="dsub" x="160" y="250"> </text></svg>`;
  host.innerHTML = svg;
  const q = (id: string) => host.querySelector('#' + id) as SVGElement;
  const needle = q('needle'), note = q('dnote'), cents = q('dcents'), hint = q('dhint'), sub = q('dsub'), okz = q('okzone');
  let lastTol = -1;

  return {
    update(s: DialState) {
      if (s.tolerance !== lastTol) { okz.setAttribute('d', arc(-s.tolerance, s.tolerance, R)); lastTol = s.tolerance; }
      if (s.note === null || s.cents === null) {
        host.dataset.s = 'off'; needle.style.transform = 'rotate(0deg)';
        note.textContent = '—'; cents.textContent = ''; hint.textContent = 'Joue une note'; hint.setAttribute('fill', 'var(--d-mut)');
        sub.textContent = ''; return;
      }
      const c = s.cents, a = (Math.max(-RANGE, Math.min(RANGE, c)) / RANGE) * SWEEP;
      needle.style.transform = `rotate(${a.toFixed(2)}deg)`;
      const ok = Math.abs(c) <= s.tolerance, near = Math.abs(c) <= 8;
      host.dataset.s = ok ? 'ok' : 'on';
      note.textContent = s.note;
      cents.textContent = `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(1)} ct`;
      cents.setAttribute('fill', ok ? 'var(--d-ok)' : near ? 'var(--d-warn)' : 'var(--d-bad)');
      hint.textContent = ok ? 'JUSTE' : c > 0 ? 'Trop haut ↓ détends' : 'Trop bas ↑ tends';
      hint.setAttribute('fill', ok ? 'var(--d-ok)' : near ? 'var(--d-warn)' : 'var(--d-bad)');
      sub.textContent = [s.hz ? s.hz.toFixed(2) + ' Hz' : '', s.detail || '', s.frozen ? 'figé' : ''].filter(Boolean).join('  ·  ');
    },
  };
}
