import { store } from './store';
import { nomFichier, memoriserPiano, type FicheSeance } from './fiche';

/** Journal final : journal de l'enregistreur + fiche, dans un seul JSON à côté du WAV. */
export function journalAvecFiche(journal: string | undefined, fiche: FicheSeance | undefined): string {
  let j: Record<string, unknown> = {};
  try { j = journal ? JSON.parse(journal) as Record<string, unknown> : {}; } catch { j = { journalIllisible: journal }; }
  return JSON.stringify({ ...j, fiche }, null, 1);
}

export type ResultatExport = 'partage' | 'telechargement' | 'annule';

function telecharger(f: File): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
}

/**
 * Envoie le WAV + le JSON : feuille de partage du téléphone (choisir Drive) si possible,
 * sinon téléchargement des deux fichiers.
 */
export async function exporterSeance(id: string, fiche: FicheSeance | undefined): Promise<ResultatExport> {
  const m = await store.lire(id); if (!m) throw new Error('séance introuvable');
  if (fiche) { await store.maj(id, { fiche }); memoriserPiano(fiche.piano); }
  const base = fiche ? nomFichier(new Date(m.debut), fiche) : 'seance-' + m.debut.slice(0, 16).replace(/[:T]/g, '-');
  const wav = new File([await store.wav(id)], base + '.wav', { type: 'audio/wav' });
  const json = new File([journalAvecFiche(m.journal, fiche ?? (m.fiche as FicheSeance | undefined))], base + '.json', { type: 'application/json' });
  const files = [wav, json];
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: base }); await store.maj(id, { nomFichier: base }); return 'partage'; }
    catch (e) { if ((e as Error).name === 'AbortError') return 'annule'; /* sinon : on télécharge */ }
  }
  telecharger(json); telecharger(wav);
  await store.maj(id, { nomFichier: base });
  return 'telechargement';
}

/** Garde l'écran allumé pendant l'enregistrement (un écran éteint coupe le micro sur téléphone). */
export async function garderEcranAllume(): Promise<() => void> {
  type WL = { release(): Promise<void> };
  let lock: WL | null = null, actif = true;
  const prendre = async () => {
    try { lock = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WL> } }).wakeLock?.request('screen') ?? null; } catch { lock = null; }
  };
  const revenir = () => { if (actif && document.visibilityState === 'visible') void prendre(); };
  await prendre();
  document.addEventListener('visibilitychange', revenir);
  return () => { actif = false; document.removeEventListener('visibilitychange', revenir); void lock?.release(); };
}
