# Third-Party Notices

TalkType is distributed with the permissively licensed components and model assets listed below. No component in this distribution performs cloud transcription or requires a paid API. Electron also ships its standard `LICENSE.electron.txt` and `LICENSES.chromium.html` notices alongside the packaged application.

| Component | Version / revision | License | Project |
|---|---:|---|---|
| Electron | 43.1.0 | MIT | https://www.electronjs.org/ |
| React and React DOM | 19.2.7 | MIT | https://react.dev/ |
| Transformers.js | 4.2.0 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| ONNX Runtime Web | bundled WASM runtime | MIT | https://onnxruntime.ai/ |
| Zod | 4.4.3 | MIT | https://zod.dev/ |
| Lucide React | 1.24.0 | ISC | https://lucide.dev/ |
| Xenova/whisper-base | revision `64da57285918e20ea79ea5c88eed7197933abaa8` | Apache-2.0 | https://huggingface.co/Xenova/whisper-base |
| Xenova/whisper-tiny (optional) | revision `5332fcc35e32a33b86612b9a57a89be7906102b1` | Apache-2.0 | https://huggingface.co/Xenova/whisper-tiny |
| Xenova/whisper-small (optional) | revision `2d67713f236afa48a18992566e7647f6ca848e13` | Apache-2.0 | https://huggingface.co/Xenova/whisper-small |

Dependency versions and integrity hashes are pinned in `package-lock.json`, `resources/models/catalog.lock.json`, `resources/models/manifest.lock.json`, and `resources/runtime/manifest.lock.json`. License files included inside dependency packages remain part of their respective distributions.

## TalkType brand asset provenance

The TalkType icon is original project artwork generated on 2026-07-15 with OpenAI's built-in image generation tool. No source image, third-party logo, trademark, wordmark, or font was supplied. The selected source was locally chroma-keyed, resized, and exported into the Windows PNG, multi-resolution ICO, and installer sidebar derivatives.

Final generation prompt:

> Use case: logo-brand. Asset type: Windows desktop application icon source, 1024 x 1024 square. Create an original TalkType symbol: an indigo rounded-square tile containing a symmetric microphone capsule whose central negative-space stem transitions cleanly into a text insertion caret, with exactly two small cyan audio ticks, one on each side. Crisp flat vector-like bitmap, minimal geometric construction, strong silhouette, professional desktop utility branding. Centered with generous padding and optimized for 16 pixels. Deep indigo tile, near-white microphone/caret, restrained bright cyan ticks. Perfectly flat solid `#00ff00` chroma-key background. No text, letters, wordmark, watermark, mockup, 3D, bevel, gloss, photographic detail, or cast shadow.

Source and legibility proof are retained in `artifacts/design/brand/` in the source repository. Packaged users receive only the final application artwork.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Apache License 2.0

Components identified as Apache-2.0 are licensed under the Apache License, Version 2.0. A complete copy is available at https://www.apache.org/licenses/LICENSE-2.0 and in the corresponding dependency or model repository. Unless required by applicable law or agreed to in writing, software distributed under that license is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
