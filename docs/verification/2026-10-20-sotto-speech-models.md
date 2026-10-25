# Sotto's speech models: Parakeet Ultra converted, Parakeet v2 mirrored (ADR-0094)

Made and checked on October 20, 2026, on the Windows laptop. The conversion ran in WSL (Ubuntu, Python 3.12, NeMo 3.0.0, PyTorch 2.14.1 on CPU, onnx 1.23.2, onnxruntime 1.31.0); forge was not reachable over SSH that day. Every transcript was made on Windows by `sherpa-onnx-node` 1.13.8, the version in `package.json`, loading each folder the way `src/main/asr/speechEngine.ts` does. The transcripts are in `artifacts/speech-model-picker/sotto-speech-models-transcripts.json`.

## Parakeet Ultra

Moondream publishes Parakeet Ultra only as Hugging Face weights: `moondream/parakeet-ultra`, `model.safetensors`, 1,255,353,386 bytes, SHA-256 `c9608f36…466717dc`, float16. `scripts/speech-models/map-hf-to-nemo.py` loads NVIDIA's `parakeet-tdt-0.6b-v3.nemo` (SHA-256 `3cbdc858…a588d10d`) and maps each of its 725 tensors to its Hugging Face name with the key mapping from transformers' `convert_nemo_to_hf.py`.

- **The mapping is right.** Applied first to NVIDIA's own Hugging Face export of v3 (`model.safetensors`, SHA-256 `3a202636…7d6a5e11`), it reproduced all 725 tensors of the `.nemo` bit for bit, with no Hugging Face key left over.
- **Ultra is not v3.** Ultra has 729 tensors: the 725 plus six `vad_head.*` tensors, a voice-activity head NeMo's model does not have, which were left out. 651 of the 725 differ from v3's.
- **The export.** sherpa-onnx's `scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py` (commit `23e65586`), run on the saved `.nemo`, made the four files. The only change to it set the encoder's `url` metadata to `https://huggingface.co/moondream/parakeet-ultra (parakeet-tdt-0.6b-v3 architecture)`; sherpa-onnx 1.13 knows a TDT model by "tdt" in that string. `tokens.txt` came out identical to v3's.
- **Against the community export** (`tpmaerk/parakeet-ultra-sherpa-onnx-int8`, used only as a cross-check):
  - Every graph is node for node the same, and the joiner is byte for byte the same.
  - In the encoder, five scalar quantization scales differ in the last bit.
  - In the decoder, the 8-bit embedding is quantized over Ultra's own range, −4.8125 to 5.0898. The community file's range is wider. Both are within one quantization step of Ultra's float embedding on every row.
- **A control.** The same chain run on NVIDIA's unchanged v3 gives transcripts that differ from k2-fsa's published v3 on 13 of the 35 clips below, each by a word or two or by punctuation. In every language their error rates are within one word of each other. This is what a newer PyTorch and onnxruntime change in the export itself, and it is smaller than the gap between Ultra and v3.

## Parakeet v2

k2-fsa's `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`, unchanged. Each file's SHA-256 matched Hugging Face's own record of it.

## Published

Both are pre-releases on `millZach/Sotto-releases`, never marked Latest, so the updater, which reads only the release marked Latest, never sees them. Latest was still `v0.1.37` after publishing. GitHub's own digest of every asset matches the pin in `src/shared/speechModel.ts`.

| Tag | File | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `speech-model-parakeet-ultra-int8-1` | `encoder.int8.onnx` | 652,282,328 | `c958c1344fd795beba8f5d29c44dc0f27f5f92c3f75ad83599765ae06ce4f1d3` |
| | `decoder.int8.onnx` | 11,845,274 | `1fab98fe6c12aded87d2da66272cc9e148d0a0044ce3850a12fe56302ec4a922` |
| | `joiner.int8.onnx` | 6,355,277 | `8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2` |
| | `tokens.txt` | 93,939 | `d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d` |
| `speech-model-parakeet-tdt-0.6b-v2-int8-1` | `encoder.int8.onnx` | 652,184,296 | `a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab` |
| | `decoder.int8.onnx` | 7,257,753 | `b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e` |
| | `joiner.int8.onnx` | 1,739,080 | `7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2` |
| | `tokens.txt` | 9,384 | `ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d` |

## Transcripts

`scripts/asr-bench/verify-speech-models.mjs` transcribed 31 recorded clips with references and sherpa-onnx's four test clips with each model:

- English: 6 Common Voice clips, 42 words.
- Multilingual LibriSpeech: 5 clips each of German, Spanish, French, Italian and Polish, 149 to 205 words each.

The scorer is the repository's own (`scripts/asr-bench/wer.mjs`: lower case, no punctuation, compounds reconciled). Word error rate, in percent, over all of a language's words:

| Model | English | German | Spanish | French | Italian | Polish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Parakeet v3 (published) | 19.0 | 8.7 | 2.5 | 15.1 | 14.4 | 2.9 |
| Parakeet Ultra (Sotto's) | 14.3 | 8.1 | 3.5 | 5.4 | 13.4 | 2.9 |
| Parakeet Ultra (community, not shipped) | 14.3 | 8.1 | 3.5 | 7.3 | 12.9 | 3.5 |
| Parakeet v2 | 16.7 | 74.5 | 59.3 | 71.2 | 76.4 | 98.2 |

So few words decide nothing about which model is better; they show that each loads in the engine Sotto ships and transcribes correctly.

- **Ultra.** Its English and French are better than v3's on these clips, and its other languages level.
- **v2.** It transcribes English and, as its card says, nothing else: other languages come out as English-sounding words.
- **One sentence, every model.** On sherpa-onnx's English clip all of them wrote "Ask not what your country can do for you, ask what you can do for your country." On its German and French clips v3 and Ultra agree word for word, and on its Spanish clip but for one accent ("qué").

Each model loaded in 4 to 6 seconds here.
