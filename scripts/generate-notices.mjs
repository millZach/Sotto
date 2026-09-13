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

const ofl = (copyrightLine) => `${copyrightLine}

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

// Bundled faces share the OFL 1.1 body with their own copyright line.
const manropeOfl = ofl('Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)')
const splineSansMonoOfl = ofl('Copyright 2022 The Spline Sans Mono Project Authors (https://github.com/SorkinType/SplineSansMono)')
const bricolageGrotesqueOfl = ofl('Copyright 2022 The Bricolage Grotesque Project Authors (https://github.com/ateliertriay/bricolage)')

// Markdown rendering and highlighting packages bundled into the renderer, grouped by copyright line.
const markdownMit = microsoftMit.replace(
  'Copyright (c) Microsoft Corporation. All rights reserved.',
  `bail, ccount, mdast-util-to-string, unified, unist-util-is, unist-util-position, unist-util-visit, vfile
Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

comma-separated-tokens, hast-util-whitespace, mdast-util-to-hast, space-separated-tokens, trough, unist-util-stringify-position, unist-util-visit-parents
Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

decode-named-character-reference, hast-util-to-jsx-runtime, lowlight, markdown-table, mdast-util-find-and-replace, mdast-util-from-markdown, mdast-util-gfm, mdast-util-gfm-footnote, mdast-util-to-markdown, micromark, micromark-core-commonmark, micromark-extension-gfm-table, micromark-factory-destination, micromark-factory-label, micromark-factory-space, micromark-factory-title, micromark-factory-whitespace, micromark-util-character, micromark-util-chunked, micromark-util-classify-character, micromark-util-combine-extensions, micromark-util-decode-numeric-character-reference, micromark-util-decode-string, micromark-util-html-tag-name, micromark-util-normalize-identifier, micromark-util-resolve-all, micromark-util-sanitize-uri, micromark-util-subtokenize, remark-gfm, remark-rehype, vfile-message
Copyright (c) Titus Wormer <tituswormer@gmail.com>

devlop
Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>

escape-string-regexp, is-plain-obj
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

estree-util-is-identifier-name, mdast-util-gfm-autolink-literal, mdast-util-gfm-strikethrough, mdast-util-gfm-table, mdast-util-gfm-task-list-item, micromark-extension-gfm, micromark-extension-gfm-autolink-literal, micromark-extension-gfm-strikethrough, micromark-extension-gfm-task-list-item
Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

extend
Copyright (c) 2014 Stefan Thomas

html-url-attributes
Copyright (c) Titus Wormer

inline-style-parser
Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>

longest-streak, trim-lines
Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>

mdast-util-phrasing
Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
Copyright (c) 2017 Victor Felder <victor@draft.li>

micromark-extension-gfm-footnote
Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>

property-information
Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

react-markdown
Copyright (c) Espen Hovlandsdal

remark-parse
Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>

style-to-js
Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>

style-to-object
Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>`,
)

// Provider icon paths in src/renderer/src/agents/ProviderMark.tsx are adapted from T3 Code
// apps/web/src/components/Icons.tsx at d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3.
const t3CodeMit = microsoftMit.replace('Copyright (c) Microsoft Corporation. All rights reserved.', 'Copyright (c) 2026 T3 Tools Inc.')

// Preserve the updater dependency notices when regenerating the bundled inventory.
const updaterMit = microsoftMit.replace(
  'Copyright (c) Microsoft Corporation. All rights reserved.',
  `electron-updater, builder-util-runtime
Copyright (c) 2015 Loopline Systems

fs-extra
Copyright (c) 2011-2017 JP Richardson

jsonfile
Copyright (c) 2012-2015, JP Richardson <jprichardson@gmail.com>

universalify
Copyright (c) 2017, Ryan Zimmerman <opensrc@ryanzim.com>

js-yaml
Copyright (C) 2011-2015 by Vitaly Puzrin

lazy-val
Copyright (c) Vladimir Krivosheev

lodash.escaperegexp
Copyright jQuery Foundation and other contributors <https://jquery.org/>
Based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative
Reporters & Editors <http://underscorejs.org/>

lodash.isequal
Copyright JS Foundation and other contributors <https://js.foundation/>
Based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative
Reporters & Editors <http://underscorejs.org/>

debug
Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

ms
Copyright (c) 2020 Vercel, Inc.

supports-color, has-flag
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)`,
)

const updaterIsc = `graceful-fs
Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors

semver
Copyright (c) Isaac Z. Schlueter and Contributors

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
  ['Windows updater dependency MIT licenses', updaterMit],
  ['Windows updater dependency ISC licenses', updaterIsc],
  ['sax Blue Oak Model License 1.0.0', await read('node_modules/sax/LICENSE.md')],
  ['Hugging Face Jinja MIT license', await read('node_modules/@huggingface/jinja/LICENSE')],
  ['ONNX Runtime MIT license', microsoftMit],
  ['Platform.js MIT license', await read('node_modules/platform/LICENSE')],
  ['GUID TypeScript ISC license', guidIsc],
  ['Protocol Buffers BSD 3-Clause license', await read('node_modules/protobufjs/LICENSE')],
  ['Apache License 2.0', await read('node_modules/@huggingface/transformers/LICENSE')],
  ['Markdown rendering MIT licenses', markdownMit],
  ['Markdown rendering ISC license', `@ungap/structured-clone
${await read('node_modules/@ungap/structured-clone/LICENSE')}`],
  ['highlight.js BSD 3-Clause license', await read('node_modules/highlight.js/LICENSE')],
  ['T3 Code MIT license', t3CodeMit],
  ['Manrope SIL Open Font License 1.1', manropeOfl],
  ['Spline Sans Mono SIL Open Font License 1.1', splineSansMonoOfl],
  ['Bricolage Grotesque SIL Open Font License 1.1', bricolageGrotesqueOfl],
]

const table = NOTICE_COMPONENTS.map((component) =>
  `| \`${component.name}\`${component.nameSuffix ?? ''} | \`${component.version}\` | ${component.license} | ${component.attribution} |`,
).join('\n')

const sections = licenseSections.map(([heading, text]) =>
  `## ${heading}\n\n\`\`\`text\n${text.trim()}\n\`\`\``,
).join('\n\n')

const naturalVoiceNotice = `## Optional Supertonic natural voices

AI-generated speech from Supertonic is available as an explicit optional download. Model weights and the ten preset voice styles are by Supertone Inc.; this Transformers.js conversion is by the Hugging Face ONNX community. The pinned conversion is \`onnx-community/Supertonic-TTS-ONNX\` revision \`cff123c84b0655d9d647641f1b532c3cbb8f7faa\`. The complete asset names, sizes, and SHA-256 hashes are in \`src/main/agents/speechModelManifest.json\`. No Supertonic weights are included in the installer.

The model is licensed under **OpenRAIL-M**, not MIT. Downloading or using these voices is subject to the complete license below, including the use restrictions in Attachment A. Users of these voices must comply with those restrictions; redistributed model copies must retain this license, notices, and the required restrictions. Speech produced by these voices is machine-generated. No third-party subscription or paid API is used for local synthesis.

Upstream model: https://huggingface.co/Supertone/supertonic

Conversion: https://huggingface.co/onnx-community/Supertonic-TTS-ONNX/tree/cff123c84b0655d9d647641f1b532c3cbb8f7faa

License source: https://huggingface.co/Supertone/supertonic/resolve/b6856d033f622c63ea29441795be266a1133e227/LICENSE

The following is the unmodified upstream license (SHA-256 \`0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f\`).

\`\`\`text
${(await read('docs/notices/supertonic-LICENSE.txt')).trim()}
\`\`\``

const output = `# Third-Party Notices

Sotto sends dictated audio to Microsoft MAI-Transcribe-2 through OpenRouter using the user's API key. This inventory covers code included in the Electron distribution, JavaScript bundled into the renderer and natural speech worker, the ONNX Web runtime used by Transformers.js for local natural speech, the Windows updater tree compiled into the main-process bundle, and the one external Node runtime dependency retained in app.asar. Versions are pinned by package-lock.json and the runtime lock manifest.

Electron additionally ships its exact upstream \`LICENSE.electron.txt\` and comprehensive \`LICENSES.chromium.html\` beside \`Sotto.exe\` in the Windows installation, and inside \`Sotto.app/Contents/Resources\` on macOS. The latter contains Chromium's component-by-component notices and license texts and is the authoritative inventory for Chromium's own bundled third-party code.

| Component | Version / revision | License | Copyright / attribution |
|---|---|---|---|
${table}

\`electron-updater\` and everything below it in that list are development dependencies of this project, but the Windows update checker is compiled into the main-process bundle rather than resolved from \`node_modules\` at runtime, so their code is redistributed inside app.asar and is inventoried here. They are absent from the macOS build path only in the sense that macOS has no update feed; the same bundle ships on every platform.

## Sotto brand asset provenance

The Sotto icon is original project artwork generated on 2026-07-15 with OpenAI's built-in image generation tool. No source image, third-party logo, trademark, wordmark, or font was supplied. The selected source was locally chroma-keyed, resized, and exported into the Windows PNG, multi-resolution ICO, and installer sidebar derivatives.

Final generation prompt:

> Use case: logo-brand. Asset type: Windows desktop application icon source, 1024 x 1024 square. Create an original Sotto symbol: an indigo rounded-square tile containing a symmetric microphone capsule whose central negative-space stem transitions cleanly into a text insertion caret, with exactly two small cyan audio ticks, one on each side. Crisp flat vector-like bitmap, minimal geometric construction, strong silhouette, professional desktop utility branding. Centered with generous padding and optimized for 16 pixels. Deep indigo tile, near-white microphone/caret, restrained bright cyan ticks. Perfectly flat solid \`#00ff00\` chroma-key background. No text, letters, wordmark, watermark, mockup, 3D, bevel, gloss, photographic detail, or cast shadow.

Every platform derivative descends from that same original artwork: the macOS \`.icns\` is derived by electron-builder from \`build/icon.png\` at package time and is not committed, and the macOS menu-bar template images \`resources/tray/sottoTemplate.png\` and \`sottoTemplate@2x.png\` are rendered from \`build/tray-template.svg\`.

Source and legibility proof are retained in \`artifacts/design/brand/\` in the source repository. Packaged users receive only the final application artwork.

${sections}

${naturalVoiceNotice}
`

await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), output, 'utf8')
