/* ============================================================
   AUFNAHME – Worker: Mikrofon → 16 kHz → Sprache erkennen
   ------------------------------------------------------------
   Bekommt den Audiostrom als ReadableStream von AudioData
   (MediaStreamTrackProcessor im Hauptfenster) und arbeitet
   ihn hier ab. Ein Worker wird vom Browser nicht gedrosselt,
   wenn das Fenster im Hintergrund liegt – die Hauptseite schon.

   Silero-VAD (v4, 16 kHz, 512 Proben = 32 ms je Schritt)
   entscheidet, ob gesprochen wird. Gemeldet werden fertige
   Abschnitte: von kurz vor dem ersten Wort bis kurz nach dem
   letzten, höchstens 25 Sekunden.
   ============================================================ */
import { Resampler, dbfs } from './dsp.js';
import { modell } from './modelle.js';

const FR = 512;                    // 32 ms
let ort = null, vad = null, h = null, c = null;
let E = {
  start: 0.5,          // ab dieser Wahrscheinlichkeit Sprache
  ende: 0.35,          // darunter Stille
  startFrames: 3,      // ~100 ms Sprache, bevor ein Abschnitt beginnt
  nachlauf: 56,        // ~1,8 s Stille, bis er endet – bündelt zusammenhängende Sätze
  vorlauf: 10,         // ~320 ms vor dem ersten Wort mitnehmen
  minSprache: 0.5,     // kürzere Abschnitte verwerfen (s)
  maxDauer: 28,        // länger wird geteilt (s)
  minPegel: -60        // leiser (dBFS) wird verworfen
};

const post = (art, daten, transfer) => self.postMessage(Object.assign({ art }, daten), transfer || []);

async function vadLaden() {
  ort = await import('./lib/ort.wasm.bundle.min.mjs');
  ort.env.wasm.wasmPaths = new URL('./lib/', self.location.href).href;
  ort.env.wasm.numThreads = 1;
  const bytes = await modell('silero_vad_v4.onnx');
  vad = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  zuruecksetzen();
}
function zuruecksetzen() {
  h = new ort.Tensor('float32', new Float32Array(128), [2, 1, 64]);
  c = new ort.Tensor('float32', new Float32Array(128), [2, 1, 64]);
}
async function wahrscheinlichkeit(frame) {
  const r = await vad.run({ x: new ort.Tensor('float32', frame, [1, FR]), h, c });
  h = r.new_h; c = r.new_c;
  return r.prob.data[0];
}

/* ---- Zustandsmaschine ---- */
let rest = new Float32Array(0);
let vorpuffer = [];                 // letzte Frames vor dem Start
let laeuft = false;                 // Abschnitt offen?
let frames = [];                    // Frames des offenen Abschnitts
let sprechFrames = 0, stilleFolge = 0, anlauf = 0;
let pegelSumme = 0, pegelN = 0, letzteMeldung = 0, zuLeise = 0, abschnitte = 0;
let maxP = 0;

function abschliessen() {
  // Nachlauf auf ~320 ms kürzen – die restliche Stille hilft niemandem.
  const ueber = Math.max(0, stilleFolge - 10);
  const nutz = frames.slice(0, frames.length - ueber);
  const pcm = new Float32Array(nutz.length * FR);
  nutz.forEach((f, i) => pcm.set(f, i * FR));
  const dauer = pcm.length / 16000;
  const sprache = sprechFrames * FR / 16000;
  laeuft = false; frames = []; sprechFrames = 0; stilleFolge = 0;
  if (sprache < E.minSprache) return;
  const db = dbfs(pcm);
  if (db < E.minPegel) { zuLeise++; return; }
  const t1 = Date.now() - Math.round(ueber * FR / 16);
  abschnitte++;
  post('abschnitt', { t0: t1 - Math.round(dauer * 1000), t1, db, pcm }, [pcm.buffer]);
}

async function frame(f) {
  const p = await wahrscheinlichkeit(f);
  if (p > maxP) maxP = p;
  let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  pegelSumme += s / f.length; pegelN++;

  if (!laeuft) {
    vorpuffer.push(f); if (vorpuffer.length > E.vorlauf) vorpuffer.shift();
    anlauf = p >= E.start ? anlauf + 1 : 0;
    if (anlauf >= E.startFrames) {
      laeuft = true; frames = vorpuffer.slice(); vorpuffer = [];
      sprechFrames = anlauf; stilleFolge = 0; anlauf = 0;
    }
  } else {
    frames.push(f);
    if (p >= E.ende) { sprechFrames++; stilleFolge = 0; } else stilleFolge++;
    if (stilleFolge >= E.nachlauf || frames.length * FR >= E.maxDauer * 16000) abschliessen();
  }

  const jetzt = Date.now();
  if (jetzt - letzteMeldung > 250) {
    post('pegel', { db: 10 * Math.log10(pegelSumme / Math.max(1, pegelN) + 1e-12),
                    p: maxP, sprache: laeuft, zuLeise, abschnitte });
    pegelSumme = 0; pegelN = 0; maxP = 0; letzteMeldung = jetzt;
  }
}

async function lesen(strom, rate) {
  const rs = new Resampler(rate, 16000);
  const leser = strom.getReader();
  let quellrate = rate;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    const ad = value;
    try {
      if (ad.sampleRate !== quellrate) { quellrate = ad.sampleRate; Object.assign(rs, new Resampler(quellrate, 16000)); }
      const n = ad.numberOfFrames;
      const mono = new Float32Array(n);
      ad.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });
      const neu = rs.verarbeite(mono);
      const z = new Float32Array(rest.length + neu.length);
      z.set(rest); z.set(neu, rest.length);
      let i = 0;
      for (; i + FR <= z.length; i += FR) await frame(z.slice(i, i + FR));
      rest = z.slice(i);
    } finally { ad.close(); }
  }
  if (laeuft) abschliessen();
  post('ende', {});
}

self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.art === 'einstellungen') Object.assign(E, m.werte || {});
    if (m.art === 'start') {
      Object.assign(E, m.werte || {});
      if (!vad) { post('status', { text: 'Sprachmodell wird geladen' }); await vadLaden(); }
      post('status', { text: 'Aufnahme läuft' });
      await lesen(m.strom, m.rate);
    }
  } catch (e) {
    post('fehler', { text: String(e && e.message || e) });
  }
};
