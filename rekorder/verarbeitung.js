/* ============================================================
   VERARBEITUNG – Worker: Stimme und Text
   ------------------------------------------------------------
   Arbeitet Abschnitt für Abschnitt ab:
     1. Stimmabdruck (WeSpeaker ResNet34, 256 Werte), wenn der
        Abschnitt mindestens eine Sekunde lang ist
     2. Whisper small, Deutsch

   Bewusst nacheinander und nicht parallel: Whisper nutzt
   ohnehin alle Kerne, die es bekommt. Was liegen bleibt,
   wartet im Speicher der Seite und übersteht einen Neustart.
   ============================================================ */
import { kaldiFbank } from './dsp.js';
import { Whisper } from './whisper.js';
import { modell, json, text } from './modelle.js';

let ort = null, stimme = null, whisper = null;

const post = (art, d, tr) => self.postMessage(Object.assign({ art }, d), tr || []);

async function laden(threads) {
  ort = await import('./lib/ort.wasm.bundle.min.mjs');
  ort.env.wasm.wasmPaths = new URL('./lib/', self.location.href).href;
  ort.env.wasm.numThreads = threads;
  const melde = (name, n, gesamt) => post('laden', { name, n, gesamt });
  const st = await modell('wespeaker_resnet34.onnx', melde);
  stimme = await ort.InferenceSession.create(st, { executionProviders: ['wasm'] });
  const meta = await json('whisper-small.json');
  const tokens = await text('whisper-small-tokens.txt');
  const enc = await modell('whisper-small-encoder.int8.onnx', melde);
  const dec = await modell('whisper-small-decoder.int8.onnx', melde);
  whisper = await Whisper.laden(ort, enc, dec, meta, tokens);
}

async function abdruck(pcm) {
  if (pcm.length < 16000) return null;
  const fb = kaldiFbank(pcm);
  const r = await stimme.run({ feats: new ort.Tensor('float32', fb.daten, [1, fb.frames, 80]) });
  const e = Float32Array.from(r.embs.data);
  let n = 0; for (const v of e) n += v * v; n = Math.sqrt(n) || 1;
  for (let i = 0; i < e.length; i++) e[i] /= n;
  return e;
}

self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.art === 'laden') {
      const t = performance.now();
      await laden(m.threads || 4);
      post('bereit', { ms: Math.round(performance.now() - t), isoliert: self.crossOriginIsolated, threads: ort.env.wasm.numThreads });
    }
    if (m.art === 'auftrag') {
      const t = performance.now();
      const emb = await abdruck(m.pcm);
      const tst = performance.now();
      const r = await whisper.transkribiere(m.pcm, m.sprache || 'de');
      r.ms.stimme = Math.round(tst - t);
      r.ms.gesamt = Math.round(performance.now() - t);
      post('ergebnis', { id: m.id, emb, ...r }, emb ? [emb.buffer] : []);
    }
  } catch (e) {
    post('fehler', { id: m.id, text: String(e && e.message || e) });
  }
};
