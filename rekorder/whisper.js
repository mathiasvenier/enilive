/* ============================================================
   WHISPER – Spracherkennung mit ONNX Runtime Web
   ------------------------------------------------------------
   Modell: whisper-small, int8, aus den offiziellen Releases von
   k2-fsa/sherpa-onnx. Zwei Teile:
     Encoder   80×3000 Log-Mel → Kreuz-Schlüssel und -Werte
     Decoder   Token für Token, mit Zwischenspeicher (448 Plätze)

   Gierige Suche, Sprache fest auf Deutsch. Das ist nicht die
   letzte Genauigkeit, aber vorhersehbar und schnell – und an
   einer Kassa mit Radio im Hintergrund entscheidet ohnehin die
   Aufnahme mehr als die Suchstrategie.

   Zusätzlich zwei Schutzmaßnahmen gegen die bekannten
   Whisper-Erfindungen bei Stille und Geräusch:
     keinSprache   Wahrscheinlichkeit des „no speech"-Tokens
     mittelLogP    mittlere Sicherheit der erzeugten Token
   Der Aufrufer verwirft, was beides schlecht aussieht.
   ============================================================ */
import { logMelWhisper } from './dsp.js';

export class Whisper {
  constructor(ort, enc, dec, meta, tokens) {
    this.ort = ort; this.enc = enc; this.dec = dec; this.meta = meta; this.tokens = tokens;
    this.unterdrueckt = new Set(meta.unterdrueckt.concat([
      meta.sot, meta.transcribe, meta.no_timestamps, meta.no_speech,
      meta.sot + 100, meta.sot + 102, meta.sot + 103, meta.sot + 101])); // translate, sot_lm, sot_prev
    this.utf8 = new TextDecoder('utf-8');
  }

  /** tokensText: Inhalt von small-tokens.txt (Base64 und Nummer je Zeile). */
  static async laden(ort, encBytes, decBytes, meta, tokensText, optionen) {
    const o = Object.assign({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' }, optionen || {});
    const enc = await ort.InferenceSession.create(encBytes, o);
    const dec = await ort.InferenceSession.create(decBytes, o);
    const tokens = [];
    for (const z of tokensText.split('\n')) {
      const i = z.lastIndexOf(' ');
      if (i < 0) continue;
      let b = '';
      try { b = atob(z.slice(0, i)); } catch (_) {}   // z. B. „= 50256“: leer
      const u = new Uint8Array(b.length);
      for (let k = 0; k < b.length; k++) u[k] = b.charCodeAt(k);
      tokens[+z.slice(i + 1)] = u;
    }
    return new Whisper(ort, enc, dec, meta, tokens);
  }

  text(ids) {
    let n = 0; for (const i of ids) n += (this.tokens[i] || []).length;
    const u = new Uint8Array(n); let p = 0;
    for (const i of ids) { const t = this.tokens[i]; if (t) { u.set(t, p); p += t.length; } }
    return this.utf8.decode(u);
  }

  /** audio: Float32Array, 16 kHz, höchstens 30 s. */
  async transkribiere(audio, sprache = 'de', maxToken = 200) {
    const M = this.meta, ort = this.ort;
    const t0 = performance.now();
    const mel = logMelWhisper(audio);
    const tm = performance.now();
    const eo = await this.enc.run({ mel: new ort.Tensor('float32', mel, [1, 80, 3000]) });
    const ck = eo.n_layer_cross_k, cv = eo.n_layer_cross_v;
    const te = performance.now();

    const L = M.n_layer, C = M.n_text_ctx, D = M.n_state;
    let sk = new ort.Tensor('float32', new Float32Array(L * C * D), [L, 1, C, D]);
    let sv = new ort.Tensor('float32', new Float32Array(L * C * D), [L, 1, C, D]);
    let toks = [M.sot, M.sprachen[sprache] || M.sprachen.de, M.transcribe, M.no_timestamps];
    let offset = 0, keinSprache = 0, logpSumme = 0;
    const aus = [];
    const V = 51865;

    for (let schritt = 0; schritt < maxToken; schritt++) {
      const feeds = {
        tokens: new ort.Tensor('int64', BigInt64Array.from(toks.map(BigInt)), [1, toks.length]),
        in_n_layer_self_k_cache: sk, in_n_layer_self_v_cache: sv,
        n_layer_cross_k: ck, n_layer_cross_v: cv,
        offset: new ort.Tensor('int64', BigInt64Array.from([BigInt(offset)]), [1])
      };
      const r = await this.dec.run(feeds);
      sk.dispose && sk.dispose(); sv.dispose && sv.dispose();
      sk = r.out_n_layer_self_k_cache; sv = r.out_n_layer_self_v_cache;
      const lg = r.logits.data;
      const n = toks.length;

      if (schritt === 0) {              // Logits an der SOT-Stelle → „keine Sprache"
        let mx = -Infinity; for (let v = 0; v < V; v++) if (lg[v] > mx) mx = lg[v];
        let s = 0; for (let v = 0; v < V; v++) s += Math.exp(lg[v] - mx);
        keinSprache = Math.exp(lg[M.no_speech] - mx) / s;
      }
      offset += n;
      const basis = (n - 1) * V;
      let best = -1, bestW = -Infinity, mx = -Infinity;
      for (let v = 0; v < V; v++) { const w = lg[basis + v]; if (w > mx) mx = w; }
      let s = 0; for (let v = 0; v < V; v++) s += Math.exp(lg[basis + v] - mx);
      for (let v = 0; v <= M.eot; v++) {          // Sonder-Token nie als Text
        if (this.unterdrueckt.has(v)) continue;
        if (schritt === 0 && (v === M.blank || v === M.eot)) continue;
        const w = lg[basis + v];
        if (w > bestW) { bestW = w; best = v; }
      }
      r.logits.dispose && r.logits.dispose();
      logpSumme += (bestW - mx) - Math.log(s);
      if (best === M.eot || best < 0) break;
      aus.push(best);
      toks = [best];
      if (offset >= C - 1) break;
      if (wiederholt(aus)) break;
    }
    sk.dispose && sk.dispose(); sv.dispose && sv.dispose();
    ck.dispose && ck.dispose(); cv.dispose && cv.dispose();
    return {
      text: this.text(aus).trim(),
      token: aus.length,
      keinSprache,
      mittelLogP: aus.length ? logpSumme / (aus.length + 1) : 0,
      ms: { mel: Math.round(tm - t0), encoder: Math.round(te - tm), decoder: Math.round(performance.now() - te) }
    };
  }
}

/* Whisper verfängt sich gelegentlich in einer Schleife („Ja, ja, ja, …").
   Bricht ab, sobald sich ein Stück von 1–8 Token mehr als viermal
   hintereinander wiederholt. */
function wiederholt(a) {
  for (let l = 1; l <= 8; l++) {
    if (a.length < l * 5) continue;
    let gleich = true;
    for (let r = 1; r < 5 && gleich; r++)
      for (let i = 0; i < l; i++)
        if (a[a.length - 1 - i] !== a[a.length - 1 - i - r * l]) { gleich = false; break; }
    if (gleich) return true;
  }
  return false;
}

/* Bekannte Erfindungen aus Untertiteln, auf denen Whisper trainiert ist. */
const ERFUNDEN = [
  /untertitel (im auftrag|der amara|von)/i, /vielen dank (fürs|für's|für das) zuschauen/i,
  /^(\W*(danke|tschüss|bis zum nächsten mal)\W*)$/i, /copyright/i, /swr \d{4}/i,
  /^\W*$/, /amara\.org/i, /www\./i
];
export function erfunden(text) { return ERFUNDEN.some(r => r.test(text)); }
