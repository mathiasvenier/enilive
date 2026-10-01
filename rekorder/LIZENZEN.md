# Herkunft und Lizenzen

| Datei | Herkunft | Lizenz |
|---|---|---|
| `lib/ort.wasm.bundle.min.mjs`, `lib/ort-wasm-simd-threaded.{mjs,wasm}` | onnxruntime-web 1.30.0 (Microsoft, npm) | MIT |
| `modelle/whisper-small-*` | k2-fsa/sherpa-onnx, Release `asr-models`, `sherpa-onnx-whisper-small` (int8), Export von OpenAI Whisper small | MIT |
| `modelle/silero_vad_v4.onnx` | k2-fsa/sherpa-onnx, Release `asr-models`, Silero VAD v4 | MIT |
| `modelle/wespeaker_resnet34.onnx` | k2-fsa/sherpa-onnx, Release `speaker-recongition-models`, WeSpeaker ResNet34 (VoxCeleb) | Apache-2.0 |

Die großen Modelle sind in Stücke unter 100 MB geteilt (Grenze von GitHub).
`modelle/modelle.json` nennt die Stücke und die SHA-256-Prüfsumme der ganzen Datei;
der Rekorder prüft sie nach dem Zusammensetzen.
