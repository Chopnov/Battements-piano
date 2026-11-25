/**
 * Stockage d'une séance sur le téléphone (IndexedDB), au fil de l'eau :
 * blocs audio de 10 s + journal + fiche. Une séance interrompue (appli fermée, téléphone
 * qui coupe l'onglet) reste récupérable à la réouverture.
 */
import { wavHeader } from '../dsp/recorder';

const DB = 'accordeur-pro-seances', V = 1;

export interface SeanceMeta {
  id: string;
  /** ISO */
  debut: string;
  sampleRate: number;
  bits: 16 | 24;
  /** Octets d'audio stockés (blocs pleins + fin) */
  octets: number;
  termine: boolean;
  /** Journal JSON complet (Recorder.journal()), mis à jour régulièrement */
  journal?: string;
  fiche?: unknown;
  nomFichier?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('seances', { keyPath: 'id' });
      db.createObjectStore('blocs');               // clé [id, index]
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(db => new Promise<T | undefined>((res, rej) => {
    const t = db.transaction(stores, mode); let out: T | undefined;
    const req = fn(t); if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => { db.close(); res(out); }; t.onerror = () => { db.close(); rej(t.error); }; t.onabort = () => { db.close(); rej(t.error); };
  }));
}

export const store = {
  async demarrer(meta: SeanceMeta): Promise<void> { await tx(['seances'], 'readwrite', t => t.objectStore('seances').put(meta)); },
  async maj(id: string, patch: Partial<SeanceMeta>): Promise<void> {
    await tx(['seances'], 'readwrite', t => {
      const os = t.objectStore('seances'), g = os.get(id);
      g.onsuccess = () => { if (g.result) os.put({ ...g.result, ...patch }); };
    });
  },
  /** Ajoute un bloc audio (index croissant) et met à jour le total d'octets */
  async bloc(id: string, index: number, bytes: Uint8Array, journal?: string): Promise<void> {
    await tx(['seances', 'blocs'], 'readwrite', t => {
      t.objectStore('blocs').put(new Blob([bytes as BlobPart]), [id, index]);
      const os = t.objectStore('seances'), g = os.get(id);
      g.onsuccess = () => { if (g.result) os.put({ ...g.result, octets: g.result.octets + bytes.length, ...(journal ? { journal } : {}) }); };
    });
  },
  async liste(): Promise<SeanceMeta[]> {
    return (await tx<SeanceMeta[]>(['seances'], 'readonly', t => t.objectStore('seances').getAll())) ?? [];
  },
  async lire(id: string): Promise<SeanceMeta | undefined> { return tx<SeanceMeta>(['seances'], 'readonly', t => t.objectStore('seances').get(id)); },
  /** WAV complet reconstitué sans tout recopier en mémoire (assemblage de Blobs) */
  async wav(id: string): Promise<Blob> {
    const m = await store.lire(id); if (!m) throw new Error('séance introuvable');
    const blobs = (await tx<Blob[]>(['blocs'], 'readonly', t => t.objectStore('blocs').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])))) ?? [];
    const n = blobs.reduce((a, b) => a + b.size, 0);
    return new Blob([wavHeader(n, m.sampleRate, m.bits) as BlobPart, ...blobs], { type: 'audio/wav' });
  },
  async supprimer(id: string): Promise<void> {
    await tx(['seances', 'blocs'], 'readwrite', t => {
      t.objectStore('seances').delete(id);
      t.objectStore('blocs').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    });
  },
};

/** Demande au navigateur de ne pas effacer ces données en cas de manque de place */
export async function stockagePersistant(): Promise<void> { try { await navigator.storage?.persist?.(); } catch { /* rien */ } }

export async function placeLibreMo(): Promise<number | undefined> {
  try { const e = await navigator.storage?.estimate?.(); return e?.quota !== undefined ? ((e.quota - (e.usage ?? 0)) / 1e6) : undefined; } catch { return undefined; }
}
