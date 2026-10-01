/* ============================================================
   SPEICHER – IndexedDB des Rekorders
   ------------------------------------------------------------
   abschnitt  { id, t0, t1, datum, gid, zustand, text, sprecher,
                cluster, db, pcm?, audio? }
                zustand: 'wartet' | 'text' | 'leer' | 'fehler'
                pcm      nur solange noch nicht verarbeitet
                audio    Opus-Pakete, 10 Tage aufbewahrt
   stimme     { name, emb, n }            angelernte Stimmen
   cluster    { id, datum, nr, emb, n, name? }   unbekannte des Tages
   kv         { k, v }                    Einstellungen, Stände

   Alles bleibt im Browser dieses Rechners. Nach Drive geht nur
   der Text, und den schickt das Dashboard.
   ============================================================ */
const NAME = 'eni-rekorder', VERSION = 1;
let db = null;

export function oeffnen() {
  if (db) return Promise.resolve(db);
  return new Promise((ok, nein) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const a = d.createObjectStore('abschnitt', { keyPath: 'id' });
      a.createIndex('datum', 'datum'); a.createIndex('zustand', 'zustand'); a.createIndex('t0', 't0');
      d.createObjectStore('stimme', { keyPath: 'name' });
      const c = d.createObjectStore('cluster', { keyPath: 'id' }); c.createIndex('datum', 'datum');
      d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => { db = r.result; ok(db); };
    r.onerror = () => nein(r.error);
  });
}

function tx(store, modus, fn) {
  return oeffnen().then(d => new Promise((ok, nein) => {
    const t = d.transaction(store, modus);
    const s = t.objectStore(store);
    let erg;
    Promise.resolve(fn(s)).then(x => { erg = x; });
    t.oncomplete = () => ok(erg);
    t.onerror = () => nein(t.error);
    t.onabort = () => nein(t.error);
  }));
}
const req = r => new Promise((ok, nein) => { r.onsuccess = () => ok(r.result); r.onerror = () => nein(r.error); });

export const put = (store, wert) => tx(store, 'readwrite', s => { s.put(wert); });
export const get = (store, key) => tx(store, 'readonly', s => req(s.get(key)));
export const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
export const alle = (store) => tx(store, 'readonly', s => req(s.getAll()));
export const nach = (store, index, wert) => tx(store, 'readonly', s => req(s.index(index).getAll(wert)));

export async function kvGet(k, def) { const e = await get('kv', k); return e ? e.v : def; }
export function kvPut(k, v) { return put('kv', { k, v }); }

/** Abschnitte mit t0 vor einem Zeitpunkt – fürs Aufräumen. */
export function aelterAls(ms) {
  return tx('abschnitt', 'readonly', s => req(s.index('t0').getAll(IDBKeyRange.upperBound(ms))));
}

export async function belegt() {
  try { const e = await navigator.storage.estimate(); return e; } catch (_) { return null; }
}
