/* ============================================================
   Service-Worker: macht die Seite „cross-origin isolated".
   ------------------------------------------------------------
   Ohne diese Isolation rechnet ONNX Runtime im Browser auf
   EINEM Kern. GitHub Pages lässt keine eigenen Kopfzeilen zu,
   deshalb setzt sie hier der Service-Worker selbst – nur für
   Antworten derselben Herkunft. Fremde Abrufe gehen unverändert
   durch; die Seite lädt ohnehin nichts von außen außer der
   Schrift (mit CORS).

   Eigene, kurze Fassung des bekannten Kniffs („coi-serviceworker").
   ============================================================ */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  if (new URL(r.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const res = await fetch(r);
    if (!res || res.status === 0 || res.type === 'opaque') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  })());
});
