/* ============================================================
   DSP – Signalverarbeitung ohne Fremdbibliothek
   ------------------------------------------------------------
   Drei Dinge:
     Resampler      Mikrofon (meist 48 kHz) auf 16 kHz
     logMelWhisper  die 80 Mel-Bänder, die Whisper erwartet
     kaldiFbank     die Merkmale, die das Stimmmodell erwartet

   Bewusst selbst geschrieben: Beide Merkmalsarten sind genau
   festgelegt (OpenAI-Whisper bzw. Kaldi), und eine kleine,
   nachprüfbare Fassung ist besser als ein Paket, das man nicht
   kennt. Gegen eine Python-Referenz geprüft (test/dsp.test.mjs).
   ============================================================ */

/* ---- Resampler -------------------------------------------
   Gefensterter Sinc-Interpolator, laufend über Blöcke hinweg.
   Bei 48 → 16 kHz wird zugleich unter 7,2 kHz tiefpassgefiltert,
   sonst falten sich hohe Töne (Kassa-Piepser) ins Sprachband. */
export class Resampler {
  constructor(von, nach = 16000, breite = 16) {
    this.von = von; this.nach = nach;
    this.schritt = von / nach;
    this.fc = Math.min(1, nach / von) * 0.92;
    this.halb = Math.ceil(breite / this.fc);
    this.puffer = new Float32Array(0);
    this.pos = 0;                      // Position im Puffer (Quellproben)
  }
  verarbeite(ein) {
    if (this.von === this.nach) return ein.slice();
    const alt = this.puffer;
    const p = new Float32Array(alt.length + ein.length);
    p.set(alt); p.set(ein, alt.length);
    const out = [];
    const H = this.halb, fc = this.fc;
    while (this.pos + H < p.length) {
      const mitte = Math.floor(this.pos), frac = this.pos - mitte;
      let s = 0;
      for (let k = -H + 1; k <= H; k++) {
        const i = mitte + k;
        if (i < 0) continue;
        const t = k - frac;
        const x = Math.PI * t * fc;
        const sinc = t === 0 ? 1 : Math.sin(x) / x;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * t / H) + 0.08 * Math.cos(2 * Math.PI * t / H);
        s += p[i] * sinc * w;
      }
      out.push(s * fc);
      this.pos += this.schritt;
    }
    // Was nicht mehr gebraucht wird, abschneiden
    const weg = Math.max(0, Math.floor(this.pos) - H);
    this.puffer = p.slice(weg);
    this.pos -= weg;
    return Float32Array.from(out);
  }
}

/* ---- Radix-2-FFT (für das Stimmmodell, 512 Punkte) -------- */
function fft2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/* ---- Whisper: Log-Mel nach OpenAI ------------------------
   n_fft 400, hop 160, Hann (periodisch), 80 Mel nach Slaney,
   Audio auf 30 s mit Nullen aufgefüllt, Rand gespiegelt.
   Ergebnis: Float32Array 80 × 3000, Zeilen = Mel-Bänder. */
const N_FFT = 400, HOP = 160, N_MEL = 80, N_FRAMES = 3000, N_SAMPLES = 480000;
let melW = null, dftCos = null, dftSin = null, hann = null;

function slaneyMel(f) {
  const fsp = 200 / 3, minHz = 1000, minMel = minHz / fsp, step = Math.log(6.4) / 27;
  return f >= minHz ? minMel + Math.log(f / minHz) / step : f / fsp;
}
function slaneyHz(m) {
  const fsp = 200 / 3, minHz = 1000, minMel = minHz / fsp, step = Math.log(6.4) / 27;
  return m >= minMel ? minHz * Math.exp(step * (m - minMel)) : fsp * m;
}

function whisperTabellen() {
  if (melW) return;
  const nb = N_FFT / 2 + 1, sr = 16000;
  melW = new Float32Array(N_MEL * nb);
  const mmin = slaneyMel(0), mmax = slaneyMel(sr / 2);
  const melF = []; for (let i = 0; i < N_MEL + 2; i++) melF.push(slaneyHz(mmin + (mmax - mmin) * i / (N_MEL + 1)));
  for (let m = 0; m < N_MEL; m++) {
    const enorm = 2 / (melF[m + 2] - melF[m]);
    for (let k = 0; k < nb; k++) {
      const f = k * sr / N_FFT;
      const lo = (f - melF[m]) / (melF[m + 1] - melF[m]);
      const hi = (melF[m + 2] - f) / (melF[m + 2] - melF[m + 1]);
      melW[m * nb + k] = Math.max(0, Math.min(lo, hi)) * enorm;
    }
  }
  dftCos = new Float32Array(nb * N_FFT); dftSin = new Float32Array(nb * N_FFT);
  for (let k = 0; k < nb; k++) for (let n = 0; n < N_FFT; n++) {
    const a = 2 * Math.PI * ((k * n) % N_FFT) / N_FFT;
    dftCos[k * N_FFT + n] = Math.cos(a); dftSin[k * N_FFT + n] = Math.sin(a);
  }
  hann = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) hann[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT);
}

export function logMelWhisper(audio) {
  whisperTabellen();
  const nb = N_FFT / 2 + 1;
  const len = Math.min(audio.length, N_SAMPLES);
  // Gespiegelter Rand (wie numpy/torch "reflect"); hinten liegen nur Nullen.
  const pad = new Float32Array(N_SAMPLES + N_FFT);
  pad.set(audio.subarray(0, len), N_FFT / 2);
  for (let i = 1; i <= N_FFT / 2; i++) pad[N_FFT / 2 - i] = len > i ? audio[i] : 0;
  const out = new Float32Array(N_MEL * N_FRAMES);
  const frame = new Float32Array(N_FFT), pw = new Float32Array(nb);
  const letzteMitInhalt = Math.ceil((len + N_FFT / 2) / HOP);   // danach nur Nullen
  let maxLog = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    if (t > letzteMitInhalt) { for (let m = 0; m < N_MEL; m++) out[m * N_FRAMES + t] = -10; continue; }
    const s = t * HOP;
    for (let n = 0; n < N_FFT; n++) frame[n] = pad[s + n] * hann[n];
    for (let k = 0; k < nb; k++) {
      let r = 0, i = 0; const o = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) { r += frame[n] * dftCos[o + n]; i += frame[n] * dftSin[o + n]; }
      pw[k] = r * r + i * i;
    }
    for (let m = 0; m < N_MEL; m++) {
      let e = 0; const o = m * nb;
      for (let k = 0; k < nb; k++) e += melW[o + k] * pw[k];
      const l = Math.log10(Math.max(e, 1e-10));
      out[m * N_FRAMES + t] = l;
      if (l > maxLog) maxLog = l;
    }
  }
  const unten = Math.max(maxLog, -10) - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], unten) + 4) / 4;
  return out;
}

/* ---- Kaldi-Fbank für das Stimmmodell (WeSpeaker) ---------
   80 Bänder, 25/10 ms, Hamming, Vorbetonung 0,97, ohne Dither,
   Abtastwerte im 16-Bit-Bereich, danach Mittelwert je Band
   abgezogen. Ergebnis: Float32Array frames × 80. */
let kaldiBanks = null, hamming = null;
function kaldiMel(f) { return 1127 * Math.log(1 + f / 700); }
function kaldiTabellen() {
  if (kaldiBanks) return;
  const N = 512, sr = 16000, nb = 80, lowF = 20, highF = sr / 2;
  const mLo = kaldiMel(lowF), mHi = kaldiMel(highF), d = (mHi - mLo) / (nb + 1);
  kaldiBanks = new Float32Array(nb * (N / 2 + 1));
  for (let b = 0; b < nb; b++) {
    const l = mLo + b * d, c = mLo + (b + 1) * d, r = mLo + (b + 2) * d;
    for (let k = 0; k < N / 2; k++) {
      const m = kaldiMel(k * sr / N);
      const v = Math.min((m - l) / (c - l), (r - m) / (r - c));
      kaldiBanks[b * (N / 2 + 1) + k] = v > 0 ? v : 0;
    }
  }
  hamming = new Float32Array(400);
  for (let n = 0; n < 400; n++) hamming[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / 399);
}

export function kaldiFbank(audio) {
  kaldiTabellen();
  const W = 400, S = 160, N = 512, nb = 80;
  if (audio.length < W) return { daten: new Float32Array(0), frames: 0 };
  const frames = 1 + Math.floor((audio.length - W) / S);
  const out = new Float32Array(frames * nb);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let t = 0; t < frames; t++) {
    re.fill(0); im.fill(0);
    let sum = 0;
    for (let i = 0; i < W; i++) { re[i] = audio[t * S + i] * 32768; sum += re[i]; }
    const mean = sum / W;
    for (let i = 0; i < W; i++) re[i] -= mean;
    for (let i = W - 1; i >= 1; i--) re[i] -= 0.97 * re[i - 1];
    re[0] -= 0.97 * re[0];
    for (let i = 0; i < W; i++) re[i] *= hamming[i];
    fft2(re, im);
    for (let b = 0; b < nb; b++) {
      let e = 0; const o = b * (N / 2 + 1);
      for (let k = 0; k < N / 2; k++) { const w = kaldiBanks[o + k]; if (w) e += w * (re[k] * re[k] + im[k] * im[k]); }
      out[t * nb + b] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }
  for (let b = 0; b < nb; b++) {
    let m = 0; for (let t = 0; t < frames; t++) m += out[t * nb + b];
    m /= frames;
    for (let t = 0; t < frames; t++) out[t * nb + b] -= m;
  }
  return { daten: out, frames };
}

/** Pegel eines Abschnitts in dBFS. */
export function dbfs(x) {
  let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, x.length) + 1e-12);
}
