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

const VERSION = '1.1.0';
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
  schwelleBekannt: 0.50,    // Ähnlichkeit, ab der eine Stimme als Team erkannt wird
  aufbewahrung: 10,         // Tage Audio
  threads: 0                // 0 = automatisch
};
let E = Object.assign({}, STANDARD);

/* ---- Zustand ---- */
const Z = {
  aufnahme: false, vadBereit: false, modellBereit: false, laden: {},
  pegel: -90, p: 0, sprache: false, zuLeise: 0, warteschlange: 0, inArbeit: null,
  bruecke: null, hoch: {}, fehler: '', tag: tagVon(Date.now()), offen: new Set(),
  letzteDauer: null, isoliert: self.crossOriginIsolated,
  startTs: Date.now(),
  tempoMittel: 0, tempoSpitze: 0,
  stat: { tag: tagVon(Date.now()) }   // Tageszähler für die Statistik
};

/* Laufendes Tempo (Verhältnis Rechenzeit : Sprache) für Anzeige und Statistik. */
function statTempo(dauerS, msGesamt) {
  const f = msGesamt / 1000 / Math.max(0.1, dauerS);
  Z.tempoMittel = Z.tempoMittel ? Z.tempoMittel * 0.9 + f * 0.1 : f;
  if (f > Z.tempoSpitze) Z.tempoSpitze = f;
  Z.stat.tempoProben = (Z.stat.tempoProben || 0) + 1;
  Z.stat.tempoSumme = +((Z.stat.tempoSumme || 0) + f).toFixed(2);
  if (f > (Z.stat.tempoSpitze || 0)) Z.stat.tempoSpitze = +f.toFixed(2);
}

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
      if (offen.length > (Z.stat.warteMax || 0)) Z.stat.warteMax = offen.length;
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
  const dauer = (a.t1 - a.t0) / 1000;
  Z.letzteDauer = { audio: dauer, ms: r.ms };
  statTempo(dauer, r.ms.gesamt);
  /* Whisper schreibt bei Geräusch gern einen Satz hin, der nie gefallen
     ist. Verworfen wird, was das Modell selbst für „keine Sprache" hält
     und unsicher erzeugt hat – oder was bekannt erfunden aussieht. */
  const leer = !r.text || erfunden(r.text) ||
    (r.keinSprache > 0.6 && r.mittelLogP < -0.8) || r.keinSprache > 0.9 || r.mittelLogP < -1.8;
  a.text = korrigiere(r.text);
  a.keinSprache = +r.keinSprache.toFixed(3); a.mittelLogP = +r.mittelLogP.toFixed(3);
  if (leer) {
    a.zustand = 'leer';
    Z.stat.verworfen = (Z.stat.verworfen || 0) + 1;
  } else {
    a.zustand = 'text';
    if (probeFuer && r.emb) {
      // Läuft eine Sprechprobe, geht dieser Abschnitt als Muster an die Person.
      await probeUebernehmen(probeFuer, r.emb);
      a.sprecher = probeFuer; a.sim = 1; a.probe = true;
      if (++probeZaehler >= 4) probeBeenden();   // genug Muster – von selbst beenden
    } else {
      const s = await sprecherZuordnen(a, r.emb);
      a.sprecher = s.name; a.sim = s.sim;
    }
    if (r.emb) a.emb = Array.from(r.emb);
    Z.stat.minuten = +((Z.stat.minuten || 0) + dauer / 60).toFixed(3);
    Z.stat.sprecher = Z.stat.sprecher || {};
    Z.stat.sprecher[a.sprecher] = (Z.stat.sprecher[a.sprecher] || 0) + 1;
    const h = new Date(a.t0).getHours();
    Z.stat.stunde = Z.stat.stunde || {};
    Z.stat.stunde[h] = (Z.stat.stunde[h] || 0) + 1;
  }
  if (!leer) a.audio = await opus(a.pcm);   // Verworfenes braucht kein Audio
  delete a.pcm;
  await DB.put('abschnitt', a);
  if (!leer) tagGeaendert(a.datum);
}

/* ============================================================
   Sprecher – nur das Team zählt
   ------------------------------------------------------------
   Erkannt werden ausschließlich angelernte Stimmen (Mathias,
   Bettina, Sylvia, Haval). Alles andere heißt schlicht „Kunde".
   Kein tageweites Sammeln unbekannter Stimmen mehr – das hatte
   am 04.10. über 100 „Unbekannt"-Cluster erzeugt.

   Der beste Ähnlichkeitswert wird je Eintrag mitgeschrieben,
   damit sich die Schwelle sauber einstellen lässt.

   Sehr kurze Abschnitte ohne brauchbaren Abdruck übernehmen den
   Sprecher davor, wenn der kurz zuvor im selben Gespräch sprach.
   ============================================================ */
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function norm(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); }
function mitteln(alt, n, neu) { return norm(alt.map((x, i) => x * n + neu[i])); }

const TEAM = ['Mathias', 'Bettina', 'Sylvia', 'Haval'];
let probeFuer = null;   // läuft gerade eine Sprechprobe, und für wen?

async function sprecherZuordnen(a, emb) {
  if (!emb) {
    const tag = await DB.nach('abschnitt', 'datum', a.datum);
    const vor = tag.filter(x => x.gid === a.gid && x.zustand === 'text' && x.t1 <= a.t0 + 500)
      .sort((x, y) => y.t1 - x.t1)[0];
    if (vor && a.t0 - vor.t1 < 3000) return { name: vor.sprecher || 'Kunde', sim: null };
    return { name: 'Kunde', sim: null };
  }
  const e = Array.from(emb);
  let best = null, bw = -1;
  for (const s of await DB.alle('stimme')) { const w = cos(e, s.emb); if (w > bw) { bw = w; best = s; } }
  const sim = bw > -1 ? +bw.toFixed(3) : null;
  if (best && bw >= E.schwelleBekannt) {
    // Angelernte Stimme langsam mitführen, damit sie sich an Mikrofon und Raum gewöhnt.
    if (best.n < 50) { best.emb = mitteln(best.emb, best.n, e); best.n++; await DB.put('stimme', best); }
    return { name: best.name, sim };
  }
  return { name: 'Kunde', sim };
}

/** Eine Sprechprobe in die Stimme einer Person übernehmen. */
async function probeUebernehmen(name, emb) {
  const e = norm(Array.from(emb));
  const st = await DB.get('stimme', name);
  const neu = st ? { name, emb: mitteln(st.emb, st.n, e), n: st.n + 1 } : { name, emb: e, n: 1 };
  await DB.put('stimme', neu);
}

let probeZaehler = 0, probeTimer = null;
function probeStarten(name) {
  probeFuer = name; probeZaehler = 0;
  if (!Z.aufnahme) aufnahmeStarten();
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probeBeenden, 60000);   // Notbremse: nach 60 s von selbst aus
  zeichnen();
}
function probeBeenden() { probeFuer = null; clearTimeout(probeTimer); zeichnen(true); }

async function stimmeLoeschen(name) {
  if (!confirm('Die Stimme „' + name + '" vergessen?\n\nBisherige Gespräche behalten den Namen.')) return;
  await DB.del('stimme', name);
  zeichnen(true);
}

async function alleStimmenLoeschen() {
  if (!confirm('Alle angelernten Stimmen löschen?\n\nDanach erkennt der Rekorder niemanden mehr, bis neu angelernt wird. Bisherige Gespräche behalten ihre Namen.')) return;
  for (const s of await DB.alle('stimme')) await DB.del('stimme', s.name);
  probeFuer = null;
  zeichnen(true);
}

/* ============================================================
   Fachwörter richtigstellen (vorläufige Liste, wird in der
   Testphase mit echten Verhörern geschärft). Fixe Schreibweisen
   für Eigennamen und Stationsbegriffe nach dem Verschriften.
   ============================================================ */
const KORREKTUR = [
  [/\bk(?:ü|ie|i)h?n+(?:e|a){1,2}s{1,2}t?\b/gi, 'Kiennast'],
  [/\ben[ei]liv[e]?\b/gi, 'Enilive'],
  [/\banilive\b/gi, 'Enilive'],
  [/\bleer\s?gut\b/gi, 'Leergut'],
  [/\bliefer\s?schein\b/gi, 'Lieferschein'],
  [/\bvi(?:g|n)n?[ej]t+e\b/gi, 'Vignette'],
  [/\bwin?jette\b/gi, 'Vignette'],
  [/\bsemmel\b/gi, 'Semmel'], [/\bsemeln\b/gi, 'Semmeln'],
  [/\bmatth?ias\b/gi, 'Mathias'],
  [/\bsilvia\b/gi, 'Sylvia'],
  [/\bha[vw]al\b/gi, 'Haval'], [/\bchawal\b/gi, 'Haval'],
  [/\bbettina\b/gi, 'Bettina'],
];
function korrigiere(text) {
  let t = text || '';
  for (const [re, zu] of KORREKTUR) t = t.replace(re, zu);
  return t;
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

/* Einen einzelnen Eintrag löschen – Text und Audio. Die Tagesdatei wird
   neu geschrieben und in Drive ersetzt, der Eintrag verschwindet also
   auch dort. */
async function eintragLoeschen(id) {
  const a = await DB.get('abschnitt', id);
  if (!a) return;
  if (!confirm('Diesen Eintrag löschen?\n\n„' + (a.text || '').slice(0, 80) + '"\n\nText und Tonaufnahme werden entfernt, auch aus Drive.')) return;
  await DB.del('abschnitt', id);
  tagGeaendert(a.datum);
  zeichnen(true);
}

/* Ein ganzes Gespräch löschen – alle Einträge mit dieser Nummer. */
async function gespraechLoeschen(gid, datum) {
  const l = (await DB.nach('abschnitt', 'datum', datum)).filter(a => a.gid === gid);
  if (!l.length) return;
  if (!confirm('Das ganze Gespräch löschen?\n\n' + l.length + ' Einträge, auch die Tonaufnahmen, werden entfernt – auch aus Drive.')) return;
  for (const a of l) await DB.del('abschnitt', a.id);
  tagGeaendert(datum);
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

/* Opus-Pakete eines Abschnitts zurück zu PCM dekodieren. */
async function pcmVon(audio) {
  if (!audio) return null;
  const out = new Float32Array(audio.laenge + 16000);
  let p = 0;
  await new Promise(ok => {
    const dec = new AudioDecoder({
      output: d => { const n = d.numberOfFrames; const buf = new Float32Array(n);
        d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' }); out.set(buf.subarray(0, Math.min(n, out.length - p)), p); p += n; d.close(); },
      error: () => ok()
    });
    dec.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1 });
    for (const k of audio.pakete) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: k.t, duration: k.d, data: k.b }));
    dec.flush().then(() => { dec.close(); ok(); }, () => ok());
  });
  return out.subarray(0, p);
}

/* Ein ganzes Gespräch zu einer durchgehenden Spur zusammenfügen. Lange
   Pausen zwischen den Abschnitten werden auf 1 s gekürzt. marks sagt, an
   welcher Sekunde jeder Abschnitt beginnt – fürs Abspielen ab einer Zeile. */
async function pcmGespraech(gid, datum) {
  const segs = (await DB.nach('abschnitt', 'datum', datum))
    .filter(a => a.gid === gid && a.zustand === 'text' && a.audio).sort((a, b) => a.t0 - b.t0);
  if (!segs.length) return null;
  const teile = [], marks = []; let total = 0, prevT1 = null;
  for (const s of segs) {
    if (prevT1 != null) {
      const gapN = Math.round(Math.max(0, Math.min(1.0, (s.t0 - prevT1) / 1000)) * 16000);
      if (gapN > 0) { teile.push(new Float32Array(gapN)); total += gapN; }
    }
    const pcm = await pcmVon(s.audio);
    marks.push({ id: s.id, offset: +(total / 16000).toFixed(2) });
    teile.push(pcm); total += pcm.length; prevT1 = s.t1;
  }
  const out = new Float32Array(total); let p = 0;
  for (const t of teile) { out.set(t, p); p += t.length; }
  return { pcm: out, marks };
}

let abspieler = null, abspielQ = null;
async function abspielen(id) {
  const a = await DB.get('abschnitt', id);
  if (!a) return;
  const g = await pcmGespraech(a.gid, a.datum);
  if (!g) { alert('Für dieses Gespräch ist kein Ton mehr da.'); return; }
  const ab = abspieler || (abspieler = new AudioContext({ sampleRate: 16000 }));
  await ab.resume();
  if (abspielQ) { try { abspielQ.stop(); } catch (_) {} }
  const buf = ab.createBuffer(1, Math.max(1, g.pcm.length), 16000);
  buf.copyToChannel(g.pcm, 0);
  const q = ab.createBufferSource(); q.buffer = buf; q.connect(ab.destination);
  const m = g.marks.find(x => x.id === id);
  q.start(0, m ? m.offset : 0);   // ab der angetippten Zeile
  abspielQ = q;
}

/* PCM als 16-Bit-WAV verpacken – das spielt jedes Gerät, auch das iPhone.
   Rückgabe als base64, damit es durch die Brücke und den GM-Speicher passt. */
function wavBase64(pcm) {
  const n = pcm.length, sr = 16000;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { let x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
  const u = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* Das Dashboard bittet im Auftrag des Handys um den Ton eines ganzen
   Gesprächs (id = Gesprächsnummer). */
async function tonLiefern(gid, datum) {
  try {
    if (!datum) { const a = await DB.get('abschnitt', gid); datum = a && a.datum; }
    const g = datum ? await pcmGespraech(gid, datum) : null;
    if (!g) { brueckeSenden('tonFehler', { id: gid, text: 'kein Ton mehr vorhanden' }); return; }
    brueckeSenden('ton', { id: gid, datum, b64: wavBase64(g.pcm) });
  } catch (e) { brueckeSenden('tonFehler', { id: gid, text: String(e && e.message || e) }); }
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
             sprecher: sp, ton: l.some(a => !!a.audio),
             eintraege: l.map(a => ({ id: a.id, zeit: uhr(a.t0), sprecher: a.sprecher || 'Kunde',
               text: a.text, ton: !!a.audio, sim: (a.sim == null ? null : a.sim) })) };
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
  if (m.art === 'hoch') {
    Z.hoch = m.hoch || {};
    const h = Z.hoch[tagVon(Date.now())];
    if (h && h.fehler && h.ts !== Z._fehlerTs) { Z._fehlerTs = h.ts; Z.stat.uploadFehler = (Z.stat.uploadFehler || 0) + 1; }
    zeichnen();
  }
  if (m.art === 'tonbitte' && m.id) tonLiefern(m.id, m.datum);
  if (m.art === 'befehl' && m.befehl === 'neu_laden') location.reload();
  if (m.art === 'referenzen') referenzenMerken(m.gids || []);
});

/* Referenzen vom Handy (über die Brücke). Gespräche in dieser Liste
   behalten ihr Audio über die Aufbewahrungszeit hinaus. */
let referenzGids = new Set();
async function referenzenMerken(gids) {
  referenzGids = new Set(gids);
  await DB.kvPut('referenzen', gids);
  zeichnen(true);
}

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

function brueckeSenden(art, d) {
  window.postMessage(Object.assign({ eniRekorder: 1, art }, d || {}), location.origin);
}

function herzschlag() {
  window.postMessage({ eniRekorder: 1, art: 'herz', ts: Date.now(), version: VERSION,
    status: { aufnahme: Z.aufnahme, warteschlange: Z.warteschlange, modell: Z.modellBereit,
              fehler: Z.fehler || '', geraet: Z.geraet || '' } }, location.origin);
}

/* Lebenszeichen in Drive (über die Brücke): so sieht man den echten
   Zustand auch vom Handy aus, nicht nur auf dem Kassen-PC. */
function letzterUploadTs() {
  let m = 0; for (const d in Z.hoch) { const h = Z.hoch[d]; if (h && h.ts > m && !h.fehler) m = h.ts; } return m || null;
}
function statusSenden() {
  const inhalt = JSON.stringify({
    version: VERSION,
    aufnahme: Z.aufnahme,
    bruecke_ok: !!(Z.bruecke && Date.now() - Z.bruecke.ts < 180000),
    warteschlange: Z.warteschlange,
    zu_leise: Z.zuLeise,
    tempo: +Z.tempoMittel.toFixed(2),
    letzter_upload: letzterUploadTs(),
    letzter_neustart: Z.startTs,
    geraet: Z.geraet || '',
    fehler: Z.fehler || '',
    stand: Date.now()
  });
  brueckeSenden('status', { inhalt });
}

/* ============================================================
   Aufräumen: Audio nach zehn Tagen weg, Text bleibt
   ============================================================ */
async function aufraeumen() {
  const grenze = Date.now() - E.aufbewahrung * 864e5;
  for (const a of await DB.aelterAls(grenze)) {
    if (a.zustand === 'leer') { await DB.del('abschnitt', a.id); continue; }
    // Als Referenz markierte Gespräche behalten ihr Audio über die Zeit hinaus.
    if (a.audio && !referenzGids.has(a.gid)) { delete a.audio; await DB.put('abschnitt', a); }
  }
}

/* ============================================================
   Wächter: fehlt die Brücke, lädt die Seite sich selbst neu
   ------------------------------------------------------------
   Am 03./04.10. lief der Rekorder, aber die Brücke war nicht da –
   nichts kam in Drive an, behoben erst vor Ort mit F5. Jetzt macht
   das die Seite selbst: erst neuer Handshake, dann Neuladen.
   Höchstens dreimal je Stunde, sonst Ruhe.
   ============================================================ */
let brueckeWegSeit = 0;
function neuladenErlaubt() {
  let liste = [];
  try { liste = JSON.parse(localStorage.getItem('rk_reloads') || '[]'); } catch (_) {}
  const jetzt = Date.now();
  liste = liste.filter(t => jetzt - t < 3600e3);
  if (liste.length >= 3) { try { localStorage.setItem('rk_reloads', JSON.stringify(liste)); } catch (_) {} return false; }
  liste.push(jetzt);
  try { localStorage.setItem('rk_reloads', JSON.stringify(liste)); } catch (_) {}
  return true;
}
function wachhund() {
  const jetzt = Date.now();
  const ok = Z.bruecke && (jetzt - Z.bruecke.ts < 5 * 60000);
  if (ok) { brueckeWegSeit = 0; return; }
  // Brücke fehlt: zuerst still neu anklopfen.
  window.postMessage({ eniRekorder: 1, art: 'hallo' }, location.origin);
  if (!brueckeWegSeit) { brueckeWegSeit = jetzt; return; }
  if (jetzt - brueckeWegSeit < 5 * 60000) return;   // Karenz, damit der Handshake greifen kann
  if (neuladenErlaubt()) {
    brueckeWegSeit = 0;
    Z.stat.brueckenAus = (Z.stat.brueckenAus || 0) + 1;
    try { DB.kvPut('stat:' + Z.stat.tag, Z.stat); } catch (_) {}
    location.reload();
  }
}

/* ============================================================
   Tagesstatistik in Drive – Grundlage für die Hardware-Wahl
   ============================================================ */
async function statistikSenden() {
  const heute = tagVon(Date.now());
  if (Z.stat.tag !== heute) Z.stat = { tag: heute };   // Tageswechsel: frisch zählen
  const text = (await DB.nach('abschnitt', 'datum', heute)).filter(a => a.zustand === 'text');
  const gids = new Set(text.map(a => a.gid));
  const s = Z.stat;
  const inhalt = JSON.stringify({
    datum: heute, version: VERSION,
    gespraeche: gids.size,
    eintraege: text.length,
    minuten_sprache: +(s.minuten || 0).toFixed(1),
    last_je_stunde: s.stunde || {},
    warteschlange_max: s.warteMax || 0,
    tempo_mittel: s.tempoProben ? +(s.tempoSumme / s.tempoProben).toFixed(2) : null,
    tempo_spitze: s.tempoSpitze || null,
    verworfen_leer: s.verworfen || 0,
    verworfen_zu_leise: Z.zuLeise || 0,
    upload_fehler: s.uploadFehler || 0,
    bruecken_ausfaelle: s.brueckenAus || 0,
    neustarts: s.neustarts || 0,
    sprecher: s.sprecher || {},
    stand: Date.now()
  });
  brueckeSenden('statistik', { datum: heute, inhalt });
  try { await DB.kvPut('stat:' + heute, Z.stat); } catch (_) {}
}

async function statLaden() {
  const heute = tagVon(Date.now());
  Z.stat = await DB.kvGet('stat:' + heute, { tag: heute });
  Z.stat.tag = heute;
  Z.stat.neustarts = (Z.stat.neustarts || 0) + 1;
  try { await DB.kvPut('stat:' + heute, Z.stat); } catch (_) {}
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

const TEAMFARBE = { Mathias: '#007BA9', Bettina: '#2E7D32', Sylvia: '#8E24AA', Haval: '#E07A00' };
const FARBEN = ['#007BA9', '#E07A00', '#2E7D32', '#8E24AA', '#C62828', '#00838F', '#5D4037'];
function farbe(n) {
  if (!n || n === 'Kunde' || /^Unbekannt /.test(n)) return '#7a8890';
  if (TEAMFARBE[n]) return TEAMFARBE[n];
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
        <span class="vs">${esc(l[0].text).slice(0, 80)}</span>
        <button class="weg" data-weg-g="${gid}" data-weg-d="${tag}" title="Gespräch löschen">✕</button></summary>
      ${l.map(a => `<div class="z"><span class="zt">${uhr(a.t0)}</span>
        <button class="spn" style="color:${farbe(a.sprecher)}" data-umbenennen="${a.id}"
          title="Sprecher ändern · Ähnlichkeit ${a.sim == null ? '–' : a.sim}">${esc(a.sprecher || 'Kunde')}${a.sim == null ? '' : ' <span class="sim">' + a.sim.toFixed(2) + '</span>'}</button>
        <span class="tx">${esc(a.text)}</span>
        ${a.audio ? `<button class="play" data-play="${a.id}" title="Ab hier anhören">▶</button>` : '<span></span>'}
        <button class="weg" data-weg="${a.id}" title="Eintrag löschen">✕</button></div>`).join('')}
    </details>`;
  }).join('') : '<div class="leer">Noch keine Gespräche an diesem Tag.</div>';

  // Stimmen anlernen: je Person eine Sprechprobe aufnehmen.
  const st = await DB.alle('stimme');
  const haben = new Set(st.map(s => s.name));
  $('#unbekannt').innerHTML =
    (probeFuer
      ? `<div class="probe">Probe läuft für <b>${esc(probeFuer)}</b> – jetzt deutlich sprechen. Jeder erkannte Satz wird als Muster übernommen.
         <button class="klein" id="probe-ende">Probe beenden</button></div>`
      : '') +
    TEAM.map(n => `<div class="st">
      <span class="sp" style="--f:${farbe(n)}">${esc(n)}</span>
      <span class="n">${haben.has(n) ? ((st.find(s => s.name === n) || {}).n || 0) + ' Proben' : 'noch keine Probe'}</span>
      <button class="klein" data-probe="${esc(n)}"${probeFuer ? ' disabled' : ''}>Probe</button></div>`).join('');

  // Angelernte Stimmen
  $('#stimmen').innerHTML = (st.length ? st.map(s => `<div class="st">
      <span class="sp" style="--f:${farbe(s.name)}">${esc(s.name)}</span><span class="n">${s.n} Proben</span>
      <button class="klein grau" data-vergessen="${esc(s.name)}">Vergessen</button></div>`).join('')
    : '<div class="leer">Noch keine Stimme angelernt.</div>') +
    (st.length ? '<div style="margin-top:8px"><button class="klein grau" id="alle-weg">Alle Stimmen löschen</button></div>' : '');
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
  await statLaden();

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

  /* Tarn-Modus: Das App-Fenster zeigt im Betrieb nur den Enilive-Verlauf,
     damit es im Geschäft nicht auffällt. Der Rekorder läuft dahinter voll
     weiter – nur die Oberfläche ist verdeckt. Strg+Alt+V holt sie hervor,
     dieselbe Geste wie die Verwaltung im Dashboard. Nach einem Neustart ist
     wieder getarnt. */
  const KLEIN = [360, 240], GROSS = [1180, 860];
  const tarnen = (an) => {
    document.body.classList.toggle('tarn', an);
    try { if (an) { window.resizeTo(KLEIN[0], KLEIN[1]); } else { window.resizeTo(GROSS[0], GROSS[1]); } } catch (_) {}
  };
  tarnen(true);
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      const jetztGetarnt = document.body.classList.contains('tarn');
      tarnen(!jetztGetarnt);
      if (jetztGetarnt) zeichnen(true);   // wird sichtbar: Anzeige auffrischen
    }
  });

  /* Bedienung */
  $('#knopf-aufnahme').onclick = () => Z.aufnahme ? aufnahmeStoppen() : aufnahmeStarten();
  $('#knopf-test').onclick = selbsttest;
  $('#tag-vor').onclick = () => { Z.tag = tagVon(new Date(Z.tag + 'T12:00').getTime() - 864e5); Z.offen.clear(); zeichnen(true); };
  $('#tag-nach').onclick = () => { Z.tag = tagVon(new Date(Z.tag + 'T12:00').getTime() + 864e5); Z.offen.clear(); zeichnen(true); };
  $('#tag-heute').onclick = () => { Z.tag = tagVon(Date.now()); Z.offen.clear(); zeichnen(true); };
  document.addEventListener('click', ev => {
    if (ev.target.id === 'probe-ende') { probeBeenden(); return; }
    if (ev.target.id === 'alle-weg') { alleStimmenLoeschen(); return; }
    const t = ev.target.closest('[data-play],[data-probe],[data-vergessen],[data-umbenennen],[data-weg],[data-weg-g]');
    if (!t) return;
    if (t.dataset.play) abspielen(t.dataset.play);
    if (t.dataset.probe) probeStarten(t.dataset.probe);
    if (t.dataset.vergessen) stimmeLoeschen(t.dataset.vergessen);
    if (t.dataset.umbenennen) eintragUmbenennen(t.dataset.umbenennen);
    if (t.dataset.weg) eintragLoeschen(t.dataset.weg);
    if (t.dataset.wegG) { ev.preventDefault(); gespraechLoeschen(t.dataset.wegG, t.dataset.wegD); }
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

  /* Wächter, Lebenszeichen und Statistik. */
  setInterval(wachhund, 60000);
  setInterval(statusSenden, 5 * 60000); setTimeout(statusSenden, 20000);
  setInterval(statistikSenden, 30 * 60000); setTimeout(statistikSenden, 90000);

  // Referenzen (behalten Audio länger) aus dem Speicher laden.
  referenzGids = new Set(await DB.kvGet('referenzen', []));

  zeichnen(true);
  if (await DB.kvGet('aufnahme', E.autostart)) aufnahmeStarten();
  herzschlag();
}

start().catch(e => { Z.fehler = String(e && e.message || e); kopfZeichnen(); });

/* Für den Test von außen */
self.REKORDER = { Z, DB, tagesdatei, aufnahmeStarten, aufnahmeStoppen, VERSION };
