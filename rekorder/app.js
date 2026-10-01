/* ============================================================
   GESPRÄCHSREKORDER – Hauptseite
   ------------------------------------------------------------
   Läuft in einem eigenen Chrome-Fenster am Kassen-PC.

     Mikrofon ─► aufnahme.js (Worker): 16 kHz, Sprache erkennen
             ─► Abschnitt in IndexedDB (zustand 'wartet')
             ─► verarbeitung.js (Worker): Stimme + Whisper
             ─► Abschnitt 'text', Audio als Opus, Sprecher
             ─► Tagesdatei JJJJ-MM-TT, Format gespraechsrekorder-tag/1
             ─► Dashboard-Skript holt sie ab und legt sie in Drive

   Die Seite selbst meldet sich NICHT bei Google an. Das kann
   sie unter der Isolation nicht (das Anmeldefenster braucht die
   Verbindung zur öffnenden Seite, die die Isolation kappt). Der
   Upload läuft deshalb über die bestehende Anmeldung des
   Dashboards: Das Tampermonkey-Skript liest hier mit und reicht
   die Tagesdatei weiter.
   ============================================================ */
import * as DB from './speicher.js';
import { erfunden } from './whisper.js';

const VERSION = '1.0.3';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const z2 = n => String(n).padStart(2, '0');
const tagVon = ms => { const d = new Date(ms); return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate()); };
const uhr = (ms, sek) => { const d = new Date(ms); return z2(d.getHours()) + ':' + z2(d.getMinutes()) + (sek === false ? '' : ':' + z2(d.getSeconds())); };
const isoLokal = ms => tagVon(ms) + 'T' + uhr(ms);

/* ---- Einstellungen ---- */
const STANDARD = {
  autostart: true,
  rauschfilter: true,       // Rauschunterdrückung des Browsers
  minPegel: -60,            // dBFS, leiser wird verworfen
  pause: 60,                // s Stille → neues Gespräch
  schwelleBekannt: 0.50,    // Ähnlichkeit zu einer angelernten Stimme
  schwelleUnbekannt: 0.55,  // Ähnlichkeit innerhalb des Tages
  aufbewahrung: 10,         // Tage Audio
  threads: 0                // 0 = automatisch
};
let E = Object.assign({}, STANDARD);

/* ---- Zustand ---- */
const Z = {
  aufnahme: false, vadBereit: false, modellBereit: false, laden: {},
  pegel: -90, p: 0, sprache: false, zuLeise: 0, warteschlange: 0, inArbeit: null,
  bruecke: null, hoch: {}, fehler: '', tag: tagVon(Date.now()), offen: new Set(),
  letzteDauer: null, isoliert: self.crossOriginIsolated
};

let aufnahmeW = null, arbeitW = null, track = null;

/* ============================================================
   Start: Isolation sicherstellen
   ============================================================ */
async function isolation() {
  if (self.crossOriginIsolated) return true;
  if (!('serviceWorker' in navigator)) return false;
  await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  /* Einmal neu laden, damit der Service-Worker die Seite selbst
     ausliefert. Gegen eine Endlosschleife: höchstens einmal je Sitzung. */
  if (!sessionStorage.getItem('rk_neu')) {
    sessionStorage.setItem('rk_neu', '1');
    location.reload();
    return new Promise(() => {});
  }
  return false;
}

/* ============================================================
   Aufnahme
   ============================================================ */
async function aufnahmeStarten() {
  if (Z.aufnahme) return;
  Z.fehler = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: false,
      noiseSuppression: !!E.rauschfilter, autoGainControl: true
    } });
    track = s.getAudioTracks()[0];
    Z.geraet = track.label;
    const rate = (track.getSettings && track.getSettings().sampleRate) || 48000;
    /* MediaStreamTrackProcessor liefert die Rohdaten ohne AudioContext.
       Das ist wichtig für den Neustart in der Nacht: Ein AudioContext
       darf ohne Klick nicht anlaufen, der Prozessor schon. */
    if (typeof MediaStreamTrackProcessor === 'undefined')
      throw new Error('Dieser Browser kann das Mikrofon nicht im Hintergrund lesen (MediaStreamTrackProcessor fehlt)');
    const strom = new MediaStreamTrackProcessor({ track }).readable;
    aufnahmeW.postMessage({ art: 'start', strom, rate, werte: { minPegel: E.minPegel } }, [strom]);
    track.addEventListener('ended', () => { Z.aufnahme = false; Z.fehler = 'Mikrofon getrennt'; zeichnen(); neuVersuch(); });
    Z.aufnahme = true;
    await DB.kvPut('aufnahme', true);
  } catch (e) {
    Z.fehler = 'Mikrofon: ' + (e && e.message || e);
    neuVersuch();
  }
  zeichnen();
}

async function aufnahmeStoppen() {
  if (track) { try { track.stop(); } catch (_) {} track = null; }
  Z.aufnahme = false;
  await DB.kvPut('aufnahme', false);
  zeichnen();
}

/* Steckt jemand das Mikrofon ab oder startet Windows neu, kommt es
   wieder – solange die Aufnahme nicht absichtlich gestoppt wurde. */
let nvTimer = null;
function neuVersuch() {
  clearTimeout(nvTimer);
  nvTimer = setTimeout(async () => {
    if (!Z.aufnahme && await DB.kvGet('aufnahme', E.autostart)) aufnahmeStarten();
  }, 15000);
}

/* ============================================================
   Abschnitte: speichern, Gespräch zuordnen, abarbeiten
   ============================================================ */
let letztesEnde = 0, letzteGid = null;

async function neuerAbschnitt(m) {
  const lz = await DB.kvGet('letzter', null);
  if (lz && !letztesEnde) { letztesEnde = lz.t1; letzteGid = lz.gid; }
  /* Neues Gespräch nach einer Pause oder über Mitternacht. */
  if (!letzteGid || m.t0 - letztesEnde > E.pause * 1000 || tagVon(m.t0) !== tagVon(letztesEnde))
    letzteGid = 'g' + m.t0.toString(36);
  letztesEnde = m.t1;
  await DB.kvPut('letzter', { t1: m.t1, gid: letzteGid });
  const a = { id: 'a' + m.t0.toString(36) + Math.random().toString(36).slice(2, 5),
              t0: m.t0, t1: m.t1, datum: tagVon(m.t0), gid: letzteGid,
              zustand: 'wartet', db: m.db, pcm: m.pcm };
  await DB.put('abschnitt', a);
  Z.warteschlange++;
  abarbeiten();
}

let arbeitet = false;
async function abarbeiten() {
  if (arbeitet || !Z.modellBereit) return;
  arbeitet = true;
  try {
    for (;;) {
      const offen = (await DB.nach('abschnitt', 'zustand', 'wartet')).sort((a, b) => a.t0 - b.t0);
      Z.warteschlange = offen.length;
      zeichnen();
      if (!offen.length) break;
      const a = offen[0];
      Z.inArbeit = a.id;
      const r = await auftrag(a);
      await ergebnis(a, r);
      Z.inArbeit = null;
    }
  } finally { arbeitet = false; zeichnen(); }
}

function auftrag(a) {
  return new Promise(ok => {
    const fertig = ev => {
      const m = ev.data;
      if (m.id !== a.id) return;
      if (m.art !== 'ergebnis' && m.art !== 'fehler') return;
      arbeitW.removeEventListener('message', fertig);
      ok(m);
    };
    arbeitW.addEventListener('message', fertig);
    const pcm = a.pcm.slice();
    arbeitW.postMessage({ art: 'auftrag', id: a.id, pcm, sprache: 'de' }, [pcm.buffer]);
  });
}

async function ergebnis(a, r) {
  if (r.art === 'fehler') {
    a.zustand = 'fehler'; a.text = r.text; delete a.pcm;
    await DB.put('abschnitt', a); return;
  }
  Z.letzteDauer = { audio: (a.t1 - a.t0) / 1000, ms: r.ms };
  /* Whisper schreibt bei Geräusch gern einen Satz hin, der nie gefallen
     ist. Verworfen wird, was das Modell selbst für „keine Sprache" hält
     und unsicher erzeugt hat – oder was bekannt erfunden aussieht. */
  const leer = !r.text || erfunden(r.text) ||
    (r.keinSprache > 0.6 && r.mittelLogP < -0.8) || r.keinSprache > 0.9 || r.mittelLogP < -1.8;
  a.text = r.text; a.keinSprache = +r.keinSprache.toFixed(3); a.mittelLogP = +r.mittelLogP.toFixed(3);
  if (leer) {
    a.zustand = 'leer';
  } else {
    a.zustand = 'text';
    const s = await sprecherZuordnen(a, r.emb);
    a.sprecher = s.name; a.cluster = s.cluster;
    if (r.emb) a.emb = Array.from(r.emb);
  }
  if (!leer) a.audio = await opus(a.pcm);   // Verworfenes braucht kein Audio
  delete a.pcm;
  await DB.put('abschnitt', a);
  if (!leer) tagGeaendert(a.datum);
}

/* ============================================================
   Sprecher
   ------------------------------------------------------------
   Zuerst gegen die angelernten Stimmen. Wer dort nicht passt,
   wird mit den unbekannten Stimmen DESSELBEN Tages verglichen
   und bekommt eine Nummer: „Unbekannt 3". Die Nummer gilt nur
   für den Tag – morgen ist der Kunde ein anderer.

   Abschnitte unter einer Sekunde haben keinen brauchbaren
   Stimmabdruck. Sie übernehmen den Sprecher davor, wenn der
   im selben Gespräch höchstens drei Sekunden zuvor sprach.
   ============================================================ */
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function norm(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); }
function mitteln(alt, n, neu) { return norm(alt.map((x, i) => x * n + neu[i])); }

async function sprecherZuordnen(a, emb) {
  if (!emb) {
    const tag = await DB.nach('abschnitt', 'datum', a.datum);
    const vor = tag.filter(x => x.gid === a.gid && x.zustand === 'text' && x.t1 <= a.t0 + 500)
      .sort((x, y) => y.t1 - x.t1)[0];
    if (vor && a.t0 - vor.t1 < 3000) return { name: vor.sprecher || '', cluster: vor.cluster || null };
    return { name: '', cluster: null };
  }
  const e = Array.from(emb);
  let best = null, bw = -1;
  for (const s of await DB.alle('stimme')) { const w = cos(e, s.emb); if (w > bw) { bw = w; best = s; } }
  if (best && bw >= E.schwelleBekannt) {
    // Angelernte Stimme langsam mitführen, damit sie sich an Mikrofon und Raum gewöhnt.
    if (best.n < 50) { best.emb = mitteln(best.emb, best.n, e); best.n++; await DB.put('stimme', best); }
    return { name: best.name, cluster: null };
  }
  const cl = await DB.nach('cluster', 'datum', a.datum);
  let bc = null, bcw = -1;
  for (const c of cl) { const w = cos(e, c.emb); if (w > bcw) { bcw = w; bc = c; } }
  if (bc && bcw >= E.schwelleUnbekannt) {
    bc.emb = mitteln(bc.emb, bc.n, e); bc.n++;
    await DB.put('cluster', bc);
    return { name: bc.name || 'Unbekannt ' + bc.nr, cluster: bc.id };
  }
  const nr = cl.reduce((m, c) => Math.max(m, c.nr), 0) + 1;
  const neu = { id: a.datum + '|' + nr, datum: a.datum, nr, emb: e, n: 1 };
  await DB.put('cluster', neu);
  return { name: 'Unbekannt ' + nr, cluster: neu.id };
}

/** Eine unbekannte Stimme benennen – rückwirkend für den ganzen Tag. */
async function benennen(clusterId) {
  const c = await DB.get('cluster', clusterId);
  if (!c) return;
  const name = (prompt('Wer ist „Unbekannt ' + c.nr + '"?\n\nDie Stimme wird gespeichert und ab jetzt erkannt.', c.name || '') || '').trim();
  if (!name) return;
  const alt = await DB.get('stimme', name);
  const st = alt ? { name, emb: mitteln(alt.emb, alt.n, c.emb), n: alt.n + c.n }
                 : { name, emb: c.emb, n: c.n };
  await DB.put('stimme', st);
  c.name = name; await DB.put('cluster', c);
  for (const a of await DB.nach('abschnitt', 'datum', c.datum))
    if (a.cluster === c.id) { a.sprecher = name; await DB.put('abschnitt', a); }
  tagGeaendert(c.datum);
  zeichnen(true);
}

async function stimmeLoeschen(name) {
  if (!confirm('Die Stimme „' + name + '" vergessen?\n\nBisherige Gespräche behalten den Namen.')) return;
  await DB.del('stimme', name);
  zeichnen(true);
}

/* Einen einzelnen Eintrag umbenennen – für die Fälle, in denen die
   Zuordnung danebenliegt. Lernt die Stimme NICHT an: ein falscher
   Abdruck in einer angelernten Stimme verdirbt alle weiteren. */
async function eintragUmbenennen(id) {
  const a = await DB.get('abschnitt', id);
  if (!a) return;
  const n = prompt('Sprecher dieses Eintrags:', a.sprecher || '');
  if (n === null) return;
  a.sprecher = n.trim(); a.cluster = null;
  await DB.put('abschnitt', a);
  tagGeaendert(a.datum);
  zeichnen(true);
}

/* ============================================================
   Audio: Opus für die zehn Tage, die es aufgehoben wird
   ============================================================ */
async function opus(pcm) {
  if (!pcm || typeof AudioEncoder === 'undefined') return null;
  try {
    const pakete = [];
    const enc = new AudioEncoder({
      output: ch => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); pakete.push({ b, t: ch.timestamp, d: ch.duration }); },
      error: () => {}
    });
    enc.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 24000 });
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 16000, numberOfFrames: pcm.length,
                               numberOfChannels: 1, timestamp: 0, data: pcm }));
    await enc.flush(); enc.close();
    return { codec: 'opus', laenge: pcm.length, pakete };
  } catch (_) { return null; }
}

let abspieler = null;
async function abspielen(id) {
  const a = await DB.get('abschnitt', id);
  if (!a || !a.audio) { alert('Für diesen Eintrag ist kein Audio mehr da.'); return; }
  const ctx = abspieler || (abspieler = new AudioContext({ sampleRate: 16000 }));
  await ctx.resume();
  const out = new Float32Array(a.audio.laenge + 16000);
  let p = 0;
  await new Promise(ok => {
    const dec = new AudioDecoder({
      output: d => { const n = d.numberOfFrames; const buf = new Float32Array(n);
        d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' }); out.set(buf.subarray(0, Math.min(n, out.length - p)), p); p += n; d.close(); },
      error: () => ok()
    });
    dec.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1 });
    for (const k of a.audio.pakete) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: k.t, duration: k.d, data: k.b }));
    dec.flush().then(() => { dec.close(); ok(); }, () => ok());
  });
  const ab = ctx.createBuffer(1, Math.max(1, p), 16000);
  ab.copyToChannel(out.subarray(0, p), 0);
  const q = ctx.createBufferSource(); q.buffer = ab; q.connect(ctx.destination); q.start();
}

/* ============================================================
   Tagesdatei und Übergabe ans Dashboard
   ============================================================ */
async function tagesdatei(datum) {
  const liste = (await DB.nach('abschnitt', 'datum', datum))
    .filter(a => a.zustand === 'text').sort((a, b) => a.t0 - b.t0);
  const gr = new Map();
  for (const a of liste) { if (!gr.has(a.gid)) gr.set(a.gid, []); gr.get(a.gid).push(a); }
  const gespraeche = [...gr.entries()].map(([gid, l]) => {
    const sp = []; l.forEach(a => { if (a.sprecher && sp.indexOf(a.sprecher) < 0) sp.push(a.sprecher); });
    const b = l[0].t0, e = l[l.length - 1].t1;
    return { id: gid, beginn: isoLokal(b), ende: isoLokal(e), dauer_s: Math.round((e - b) / 1000),
             sprecher: sp, eintraege: l.map(a => ({ zeit: uhr(a.t0), sprecher: a.sprecher || '', text: a.text })) };
  });
  return { format: 'gespraechsrekorder-tag/1', datum, quelle: 'browser-rekorder ' + VERSION,
           erzeugt: isoLokal(Date.now()), gespraeche };
}

const geaenderteTage = new Set();
let sendeTimer = null;
function tagGeaendert(datum) {
  geaenderteTage.add(datum);
  clearTimeout(sendeTimer);
  sendeTimer = setTimeout(senden, 15000);
  zeichnen(true);
}

async function senden() {
  for (const d of [...geaenderteTage]) {
    geaenderteTage.delete(d);
    const inhalt = JSON.stringify(await tagesdatei(d));
    const stand = Date.now();
    await DB.kvPut('stand:' + d, stand);
    window.postMessage({ eniRekorder: 1, art: 'tag', datum: d, inhalt, stand }, location.origin);
  }
}

/* Antworten des Dashboard-Skripts. Es läuft unter Tampermonkey auf
   dieser Seite mit und meldet sich mit „brücke". */
window.addEventListener('message', async ev => {
  const m = ev.data;
  if (!m || !m.eniRekorderAntwort || ev.source !== window) return;
  if (m.art === 'bruecke') { Z.bruecke = { version: m.version, ts: Date.now() }; zeichnen(); nachreichen(); }
  if (m.art === 'hoch') { Z.hoch = m.hoch || {}; zeichnen(); }
});

/* Was noch nicht in Drive angekommen ist, erneut anbieten. */
async function nachreichen() {
  const heute = Date.now();
  for (let i = 0; i < 3; i++) {
    const d = tagVon(heute - i * 864e5);
    const st = await DB.kvGet('stand:' + d, 0);
    const h = Z.hoch[d];
    if (st && (!h || h.stand < st)) geaenderteTage.add(d);
  }
  if (geaenderteTage.size) { clearTimeout(sendeTimer); sendeTimer = setTimeout(senden, 2000); }
}

function herzschlag() {
  window.postMessage({ eniRekorder: 1, art: 'herz', ts: Date.now(), version: VERSION,
    status: { aufnahme: Z.aufnahme, warteschlange: Z.warteschlange, modell: Z.modellBereit,
              fehler: Z.fehler || '', geraet: Z.geraet || '' } }, location.origin);
}

/* ============================================================
   Aufräumen: Audio nach zehn Tagen weg, Text bleibt
   ============================================================ */
async function aufraeumen() {
  const grenze = Date.now() - E.aufbewahrung * 864e5;
  for (const a of await DB.aelterAls(grenze)) {
    if (a.zustand === 'leer') { await DB.del('abschnitt', a.id); continue; }
    if (a.audio) { delete a.audio; await DB.put('abschnitt', a); }
  }
  const cl = await DB.alle('cluster');
  for (const c of cl) if (c.datum < tagVon(grenze)) await DB.del('cluster', c.id);
}

/* ============================================================
   Anzeige
   ============================================================ */
let zTimer = null, listeNeu = true;
function zeichnen(liste) {
  if (liste) listeNeu = true;
  if (zTimer) return;
  zTimer = setTimeout(() => { zTimer = null; kopfZeichnen(); if (listeNeu) { listeNeu = false; listeZeichnen(); } }, 120);
}

function kopfZeichnen() {
  const st = $('#st-aufnahme');
  st.textContent = Z.aufnahme ? (Z.sprache ? '● spricht' : '● Aufnahme läuft') : '○ aus';
  st.className = 'chip ' + (Z.aufnahme ? (Z.sprache ? 'rot' : 'an') : 'aus');
  $('#knopf-aufnahme').textContent = Z.aufnahme ? 'Aufnahme stoppen' : 'Aufnahme starten';
  const pz = Math.max(0, Math.min(100, (Z.pegel + 70) / 60 * 100));
  $('#pegel-balken').style.width = pz + '%';
  $('#pegel-balken').className = Z.sprache ? 'sprache' : '';
  const grenze = Math.max(0, Math.min(100, (E.minPegel + 70) / 60 * 100));
  $('#pegel-grenze').style.left = grenze + '%';
  $('#pegel-text').textContent = (Z.pegel > -99 ? Z.pegel.toFixed(0) : '–') + ' dB';
  $('#f-warte').textContent = Z.warteschlange + (Z.inArbeit ? ' (1 in Arbeit)' : '');
  $('#f-leise').textContent = Z.zuLeise;
  const ld = Object.values(Z.laden);
  const g = ld.reduce((s, x) => s + x.gesamt, 0), n = ld.reduce((s, x) => s + x.n, 0);
  $('#f-modell').textContent = Z.modellBereit ? 'bereit' + (Z.threads ? ' · ' + Z.threads + ' Kerne' : '')
    : (g ? 'lädt ' + Math.round(n / 1e6) + ' / ' + Math.round(g / 1e6) + ' MB' : 'lädt …');
  $('#f-iso').textContent = Z.isoliert ? 'ja' : 'nein (nur ein Kern)';
  $('#f-geraet').textContent = Z.geraet || '–';
  const L = Z.letzteDauer;
  $('#f-tempo').textContent = L ? L.audio.toFixed(1) + ' s Sprache in ' + (L.ms.gesamt / 1000).toFixed(1) + ' s' : '–';
  const b = Z.bruecke;
  $('#f-bruecke').innerHTML = b ? '<span class="ok">verbunden</span>'
    : '<span class="schlecht">fehlt – Dashboard-Skript aktualisieren</span>';
  const h = Z.hoch[Z.tag];
  $('#f-drive').textContent = h ? 'zuletzt ' + uhr(h.ts, false) + (h.fehler ? ' · Fehler: ' + h.fehler : '') : '–';
  $('#fehler').textContent = Z.fehler || '';
  $('#fehler').style.display = Z.fehler ? '' : 'none';
}

const FARBEN = ['#007BA9', '#E07A00', '#2E7D32', '#8E24AA', '#C62828', '#00838F', '#5D4037'];
function farbe(n) {
  if (!n || /^Unbekannt /.test(n)) return '#7a8890';
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return FARBEN[h % FARBEN.length];
}

async function listeZeichnen() {
  const tag = Z.tag;
  $('#tag-text').textContent = new Date(tag + 'T12:00').toLocaleDateString('de-AT',
    { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const alle = (await DB.nach('abschnitt', 'datum', tag)).sort((a, b) => a.t0 - b.t0);
  const text = alle.filter(a => a.zustand === 'text');
  const gr = new Map();
  for (const a of text) { if (!gr.has(a.gid)) gr.set(a.gid, []); gr.get(a.gid).push(a); }
  const ids = [...gr.keys()].reverse();
  $('#f-heute').textContent = gr.size + ' Gespräche · ' + text.length + ' Einträge · ' +
    alle.filter(a => a.zustand === 'leer').length + ' verworfen';
  $('#liste').innerHTML = ids.length ? ids.map((gid, i) => {
    const l = gr.get(gid);
    const sp = [...new Set(l.map(a => a.sprecher).filter(Boolean))];
    const offen = Z.offen.has(gid) || (i === 0 && !Z.offen.size);
    return `<details class="gs" data-gid="${gid}"${offen ? ' open' : ''}><summary>
        <b>${uhr(l[0].t0, false)}–${uhr(l[l.length - 1].t1, false)}</b>
        <span class="sps">${sp.map(s => `<span class="sp" style="--f:${farbe(s)}">${esc(s)}</span>`).join('')}</span>
        <span class="vs">${esc(l[0].text).slice(0, 80)}</span></summary>
      ${l.map(a => `<div class="z"><span class="zt">${uhr(a.t0)}</span>
        <button class="spn" style="color:${farbe(a.sprecher)}" data-umbenennen="${a.id}"
          title="Sprecher ändern">${esc(a.sprecher || '–')}</button>
        <span class="tx">${esc(a.text)}</span>
        ${a.audio ? `<button class="play" data-play="${a.id}" title="Anhören">▶</button>` : ''}</div>`).join('')}
    </details>`;
  }).join('') : '<div class="leer">Noch keine Gespräche an diesem Tag.</div>';

  const cl = (await DB.nach('cluster', 'datum', tag)).sort((a, b) => a.nr - b.nr);
  $('#unbekannt').innerHTML = cl.length ? cl.map(c => `<div class="st">
      <span class="sp" style="--f:${c.name ? farbe(c.name) : '#7a8890'}">${esc(c.name || 'Unbekannt ' + c.nr)}</span>
      <span class="n">${c.n} Abschnitte</span>
      ${c.name ? '' : `<button class="klein" data-benennen="${esc(c.id)}">Benennen</button>`}</div>`).join('')
    : '<div class="leer">Heute noch niemand.</div>';
  const st = await DB.alle('stimme');
  $('#stimmen').innerHTML = st.length ? st.map(s => `<div class="st">
      <span class="sp" style="--f:${farbe(s.name)}">${esc(s.name)}</span><span class="n">${s.n} Abschnitte gelernt</span>
      <button class="klein grau" data-vergessen="${esc(s.name)}">Vergessen</button></div>`).join('')
    : '<div class="leer">Noch keine Stimme angelernt. Unter „Heute erkannt“ eine Stimme benennen.</div>';
}

/* ---- Einstellungen ---- */
function einstellungenZeigen() {
  for (const k in STANDARD) {
    const el = document.querySelector('[data-e="' + k + '"]');
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!E[k]; else el.value = E[k];
  }
}
async function einstellungSetzen(el) {
  const k = el.dataset.e;
  E[k] = el.type === 'checkbox' ? el.checked : (+el.value);
  await DB.kvPut('einstellungen', E);
  aufnahmeW && aufnahmeW.postMessage({ art: 'einstellungen', werte: { minPegel: E.minPegel } });
  if (k === 'rauschfilter' && track) {
    try { await track.applyConstraints({ noiseSuppression: !!E.rauschfilter }); } catch (_) {}
  }
  zeichnen();
}

/* ---- Selbsttest über den Lautsprecher des Jabra ----
   Die Windows-Stimmen sprechen deutsche Sätze, das Mikrofon hört
   sie. Prüft die ganze Kette, ohne dass jemand reden muss. */
/* Sprechprobe. Eine Ansage über den Lautsprecher taugt dafür nicht:
   Der Jabra rechnet sein eigenes Lautsprechersignal aus dem Mikrofon
   heraus (am Kassen-PC gemessen: Pegel bleibt bei -110 dB). Also
   spricht ein Mensch, und die Seite zeigt, was angekommen ist. */
function selbsttest() {
  const k = $('#knopf-test');
  if (!Z.aufnahme) { k.textContent = 'Erst die Aufnahme starten'; setTimeout(() => k.textContent = 'Sprechprobe', 4000); return; }
  k.textContent = 'Jetzt einen Satz sprechen – erscheint oben in der Liste';
  setTimeout(() => k.textContent = 'Sprechprobe', 15000);
}

/* ============================================================
   Ablauf
   ============================================================ */
async function start() {
  $('#version').textContent = VERSION;
  await isolation();
  Z.isoliert = self.crossOriginIsolated;

  /* Nur ein Rekorder je Rechner. Zwei offene Fenster nähmen jedes
     Gespräch doppelt auf. Das zweite wartet und übernimmt, sobald das
     erste geschlossen wird. */
  const frei = await new Promise(ok => navigator.locks.request('eni-rekorder', { ifAvailable: true },
    l => { ok(!!l); return l ? new Promise(() => {}) : undefined; }));
  if (!frei) {
    const f = $('#fehler');
    f.textContent = 'Der Rekorder läuft bereits in einem anderen Fenster. Dieses hier wartet ' +
      'und übernimmt, sobald das andere geschlossen wird.';
    f.style.display = '';
    $('#knopf-aufnahme').disabled = true;
    await new Promise(ok => navigator.locks.request('eni-rekorder', () => { ok(); return new Promise(() => {}); }));
    f.style.display = 'none'; $('#knopf-aufnahme').disabled = false;
  }

  E = Object.assign({}, STANDARD, await DB.kvGet('einstellungen', {}));
  einstellungenZeigen();

  aufnahmeW = new Worker('./aufnahme.js', { type: 'module' });
  aufnahmeW.onmessage = ev => {
    const m = ev.data;
    if (m.art === 'pegel') { Z.pegel = m.db; Z.p = m.p; Z.sprache = m.sprache; Z.zuLeise = m.zuLeise; zeichnen(); }
    else if (m.art === 'abschnitt') neuerAbschnitt(m);
    else if (m.art === 'ende') { Z.aufnahme = false; zeichnen(); neuVersuch(); }
    else if (m.art === 'fehler') { Z.fehler = 'Aufnahme: ' + m.text; Z.aufnahme = false; zeichnen(); neuVersuch(); }
  };

  arbeitW = new Worker('./verarbeitung.js', { type: 'module' });
  arbeitW.addEventListener('message', ev => {
    const m = ev.data;
    if (m.art === 'laden') { Z.laden[m.name] = { n: m.n, gesamt: m.gesamt }; zeichnen(); }
    if (m.art === 'bereit') { Z.modellBereit = true; Z.threads = m.threads; zeichnen(); abarbeiten(); }
    if (m.art === 'fehler' && !m.id) { Z.fehler = 'Modelle: ' + m.text; zeichnen(); }
  });
  const kerne = navigator.hardwareConcurrency || 4;
  /* Gemessen am Kassen-PC (12 Kerne): 4 Threads sind schneller als 8 –
     und lassen der Kasse Luft. */
  const threads = E.threads || (Z.isoliert ? Math.max(1, Math.min(4, kerne - 2)) : 1);
  arbeitW.postMessage({ art: 'laden', threads });

  /* Bedienung */
  $('#knopf-aufnahme').onclick = () => Z.aufnahme ? aufnahmeStoppen() : aufnahmeStarten();
  $('#knopf-test').onclick = selbsttest;
  $('#tag-vor').onclick = () => { Z.tag = tagVon(new Date(Z.tag + 'T12:00').getTime() - 864e5); Z.offen.clear(); zeichnen(true); };
  $('#tag-nach').onclick = () => { Z.tag = tagVon(new Date(Z.tag + 'T12:00').getTime() + 864e5); Z.offen.clear(); zeichnen(true); };
  $('#tag-heute').onclick = () => { Z.tag = tagVon(Date.now()); Z.offen.clear(); zeichnen(true); };
  document.addEventListener('click', ev => {
    const t = ev.target.closest('[data-play],[data-benennen],[data-vergessen],[data-umbenennen]');
    if (!t) return;
    if (t.dataset.play) abspielen(t.dataset.play);
    if (t.dataset.benennen) benennen(t.dataset.benennen);
    if (t.dataset.vergessen) stimmeLoeschen(t.dataset.vergessen);
    if (t.dataset.umbenennen) eintragUmbenennen(t.dataset.umbenennen);
  });
  document.addEventListener('toggle', ev => {
    const d = ev.target; if (!d.dataset || !d.dataset.gid) return;
    if (d.open) Z.offen.add(d.dataset.gid); else Z.offen.delete(d.dataset.gid);
  }, true);
  document.querySelectorAll('[data-e]').forEach(el => el.addEventListener('change', () => einstellungSetzen(el)));

  /* Die Brücke fragen, ob sie da ist. Antwortet sie nicht, steht das
     in der Anzeige – dann kommt in Drive nichts an. */
  window.postMessage({ eniRekorder: 1, art: 'hallo' }, location.origin);
  setInterval(() => window.postMessage({ eniRekorder: 1, art: 'hallo' }, location.origin), 60000);
  setInterval(herzschlag, 60000);
  setInterval(() => { const t = tagVon(Date.now()); if (t !== Z.tag && Z.tag === tagVon(Date.now() - 864e5)) { Z.tag = t; zeichnen(true); } }, 60000);
  setInterval(aufraeumen, 6 * 3600e3); setTimeout(aufraeumen, 60000);
  setInterval(() => zeichnen(true), 30000);

  zeichnen(true);
  if (await DB.kvGet('aufnahme', E.autostart)) aufnahmeStarten();
  herzschlag();
}

start().catch(e => { Z.fehler = String(e && e.message || e); kopfZeichnen(); });

/* Für den Test von außen */
self.REKORDER = { Z, DB, tagesdatei, aufnahmeStarten, aufnahmeStoppen, VERSION };
