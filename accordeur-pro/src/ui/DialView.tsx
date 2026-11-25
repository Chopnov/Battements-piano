import { useEffect, useRef } from 'react';
import { createDial, DIAL_CSS, type DialState } from './dial';

let cssDone = false;
export function Dial(props: DialState) {
  const host = useRef<HTMLDivElement>(null), dial = useRef<ReturnType<typeof createDial> | null>(null);
  useEffect(() => {
    if (!cssDone) { const st = document.createElement('style'); st.textContent = DIAL_CSS; document.head.appendChild(st); cssDone = true; }
    dial.current = createDial(host.current!);
  }, []);
  useEffect(() => { dial.current?.update(props); });
  return <div ref={host} />;
}
