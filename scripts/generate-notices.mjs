import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { NOTICE_COMPONENTS } from './verify-notices.mjs'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFile(join(root, path), 'utf8')

const microsoftMit = `MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const guidIsc = `ISC License

Copyright (c) NicolasDeveloper contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

const licenseSections = [
  ['Electron MIT license', await read('node_modules/electron/dist/LICENSE')],
  ['React, React DOM, and Scheduler MIT license', await read('node_modules/react/LICENSE')],
  ['Lucide ISC and Feather MIT licenses', await read('node_modules/lucide-react/LICENSE')],
  ['Zod MIT license', await read('node_modules/zod/LICENSE')],
  ['Hugging Face Jinja MIT license', await read('node_modules/@huggingface/jinja/LICENSE')],
  ['ONNX Runtime MIT license', microsoftMit],
  ['Platform.js MIT license', await read('node_modules/platform/LICENSE')],
  ['GUID TypeScript ISC license', guidIsc],
  ['Protocol Buffers BSD 3-Clause license', await read('node_modules/protobufjs/LICENSE')],
  ['Apache License 2.0', await read('node_modules/@huggingface/transformers/LICENSE')],
]

const table = NOTICE_COMPONENTS.map((component) =>
  `| \`${component.name}\` | \`${component.version}\` | ${component.license} | ${component.attribution} |`,
).join('\n')

const sections = licenseSections.map(([heading, text]) =>
  `## ${heading}\n\n\`\`\`text\n${text.trim()}\n\`\`\``,
).join('\n\n')

const output = `# Third-Party Notices

TalkType performs transcription locally and does not require a paid API. This inventory covers code included in the Electron distribution, JavaScript bundled into the renderer and transcription worker, the ONNX Web runtime embedded by Transformers.js, the bundled model, and the one external Node runtime dependency retained in app.asar. Versions are pinned by package-lock.json and the model/runtime lock manifests.

Electron additionally ships its exact upstream \`LICENSE.electron.txt\` and comprehensive \`LICENSES.chromium.html\` beside \`TalkType.exe\`. The latter contains Chromium's component-by-component notices and license texts and is the authoritative inventory for Chromium's own bundled third-party code.

| Component | Version / revision | License | Copyright / attribution |
|---|---|---|---|
${table}

Optional models are not part of the installer. If the user explicitly downloads them, \`Xenova/whisper-tiny\` revision \`5332fcc35e32a33b86612b9a57a89be7906102b1\` and \`Xenova/whisper-small\` revision \`2d67713f236afa48a18992566e7647f6ca848e13\` are Apache-2.0 works from Hugging Face and OpenAI Whisper contributors.

## TalkType brand asset provenance

The TalkType icon is original project artwork generated on 2026-07-15 with OpenAI's built-in image generation tool. No source image, third-party logo, trademark, wordmark, or font was supplied. The selected source was locally chroma-keyed, resized, and exported into the Windows PNG, multi-resolution ICO, and installer sidebar derivatives.

Final generation prompt:

> Use case: logo-brand. Asset type: Windows desktop application icon source, 1024 x 1024 square. Create an original TalkType symbol: an indigo rounded-square tile containing a symmetric microphone capsule whose central negative-space stem transitions cleanly into a text insertion caret, with exactly two small cyan audio ticks, one on each side. Crisp flat vector-like bitmap, minimal geometric construction, strong silhouette, professional desktop utility branding. Centered with generous padding and optimized for 16 pixels. Deep indigo tile, near-white microphone/caret, restrained bright cyan ticks. Perfectly flat solid \`#00ff00\` chroma-key background. No text, letters, wordmark, watermark, mockup, 3D, bevel, gloss, photographic detail, or cast shadow.

Source and legibility proof are retained in \`artifacts/design/brand/\` in the source repository. Packaged users receive only the final application artwork.

${sections}
`

await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), output, 'utf8')
