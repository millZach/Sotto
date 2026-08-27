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

const moonshineMit = `MIT License

Copyright (c) 2024 Useful Sensors

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

const manropeOfl = `Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`

// Both bundled faces ship under the same OFL 1.1 body; only the copyright line
// differs, so it is swapped rather than duplicating 90 lines of licence text.
const splineSansMonoOfl = manropeOfl.replace(
  'Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)',
  'Copyright 2022 The Spline Sans Mono Project Authors (https://github.com/SorkinType/SplineSansMono)',
)

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
  ['Moonshine MIT license', moonshineMit],
  ['Manrope SIL Open Font License 1.1', manropeOfl],
  ['Spline Sans Mono SIL Open Font License 1.1', splineSansMonoOfl],
]

const table = NOTICE_COMPONENTS.map((component) =>
  `| \`${component.name}\`${component.nameSuffix ?? ''} | \`${component.version}\` | ${component.license} | ${component.attribution} |`,
).join('\n')

const sections = licenseSections.map(([heading, text]) =>
  `## ${heading}\n\n\`\`\`text\n${text.trim()}\n\`\`\``,
).join('\n\n')

const output = `# Third-Party Notices

Sotto performs transcription locally and does not require a paid API. This inventory covers code included in the Electron distribution, JavaScript bundled into the renderer and transcription worker, the ONNX Web runtime embedded by Transformers.js, the bundled model, and the one external Node runtime dependency retained in app.asar. Versions are pinned by package-lock.json and the model/runtime lock manifests.

Electron additionally ships its exact upstream \`LICENSE.electron.txt\` and comprehensive \`LICENSES.chromium.html\` beside \`Sotto.exe\` in the Windows installation, and inside \`Sotto.app/Contents/Resources\` on macOS. The latter contains Chromium's component-by-component notices and license texts and is the authoritative inventory for Chromium's own bundled third-party code.

| Component | Version / revision | License | Copyright / attribution |
|---|---|---|---|
${table}

The bundled Standard model is \`onnx-community/moonshine-base-ONNX\` revision \`b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad\`, an MIT-licensed work from Useful Sensors (Moonshine) converted by the Hugging Face ONNX community. Optional models are not part of the installer. If the user explicitly downloads it, \`Xenova/whisper-tiny\` revision \`5332fcc35e32a33b86612b9a57a89be7906102b1\` is an Apache-2.0 work from Hugging Face and OpenAI Whisper contributors.

## Sotto brand asset provenance

The Sotto icon is original project artwork generated on 2026-07-15 with OpenAI's built-in image generation tool. No source image, third-party logo, trademark, wordmark, or font was supplied. The selected source was locally chroma-keyed, resized, and exported into the Windows PNG, multi-resolution ICO, and installer sidebar derivatives.

Final generation prompt:

> Use case: logo-brand. Asset type: Windows desktop application icon source, 1024 x 1024 square. Create an original Sotto symbol: an indigo rounded-square tile containing a symmetric microphone capsule whose central negative-space stem transitions cleanly into a text insertion caret, with exactly two small cyan audio ticks, one on each side. Crisp flat vector-like bitmap, minimal geometric construction, strong silhouette, professional desktop utility branding. Centered with generous padding and optimized for 16 pixels. Deep indigo tile, near-white microphone/caret, restrained bright cyan ticks. Perfectly flat solid \`#00ff00\` chroma-key background. No text, letters, wordmark, watermark, mockup, 3D, bevel, gloss, photographic detail, or cast shadow.

Every platform derivative descends from that same original artwork: the macOS \`.icns\` is derived by electron-builder from \`build/icon.png\` at package time and is not committed, and the macOS menu-bar template images \`resources/tray/sottoTemplate.png\` and \`sottoTemplate@2x.png\` are rendered from \`build/tray-template.svg\`.

Source and legibility proof are retained in \`artifacts/design/brand/\` in the source repository. Packaged users receive only the final application artwork.

${sections}
`

await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), output, 'utf8')
