/* ============================================================
   MODELLE – laden, zusammensetzen, im Browser behalten
   ------------------------------------------------------------
   Die großen Dateien liegen auf GitHub Pages in Stücken unter
   100 MB (Grenze von GitHub). Hier werden sie geholt, im
   Cache-Speicher des Browsers abgelegt und wieder zu einer
   Datei zusammengesetzt. Beim zweiten Start kommt alles aus
   dem Cache, ohne Netz.

   Die Prüfsumme wird nach dem Zusammensetzen nachgerechnet:
   Ein abgebrochener Download soll nicht als kaputtes Modell
   im Cache liegen bleiben und bei jedem Start scheitern.
   ============================================================ */
const CACHE = 'eni-rekorder-modelle-v1';
const BASIS = new URL('./modelle/', self.location.href).href;

let manifest = null;
async function liste() {
  if (manifest) return manifest;
  const r = await fetch(BASIS + 'modelle.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Modellliste nicht erreichbar (' + r.status + ')');
  manifest = (await r.json()).dateien;
  return manifest;
}

async function teilHolen(cache, name, fortschritt) {
  const url = BASIS + name;
  const hit = await cache.match(url);
  if (hit) { const b = await hit.arrayBuffer(); fortschritt(b.byteLength); return b; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  const leser = r.body.getReader(); const stuecke = []; let n = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    stuecke.push(value); n += value.length; fortschritt(value.length);
  }
  const buf = new Uint8Array(n); let p = 0;
  for (const s of stuecke) { buf.set(s, p); p += s.length; }
  await cache.put(url, new Response(buf));
  return buf.buffer;
}

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Eine Modelldatei als Uint8Array.
 * melde(name, geladen, gesamt) für die Fortschrittsanzeige.
 */
export async function modell(name, melde) {
  const l = await liste();
  const e = l[name];
  if (!e) throw new Error('Unbekanntes Modell: ' + name);
  const cache = await caches.open(CACHE);
  let geladen = 0;
  const teile = [];
  for (const t of e.teile) teile.push(new Uint8Array(await teilHolen(cache, t, n => {
    geladen += n; melde && melde(name, geladen, e.groesse);
  })));
  const ganz = new Uint8Array(e.groesse); let p = 0;
  for (const t of teile) { ganz.set(t, p); p += t.length; }
  if (e.sha256) {
    const s = await sha256(ganz.buffer);
    if (s !== e.sha256) {
      for (const t of e.teile) await cache.delete(BASIS + t);
      throw new Error(name + ': Prüfsumme stimmt nicht – Download wird beim nächsten Start wiederholt');
    }
  }
  return ganz;
}

export async function text(name) {
  return new TextDecoder().decode(await modell(name));
}

export async function json(name) {
  return JSON.parse(await text(name));
}
