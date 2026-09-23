import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const packageComponent = (name, version, license, attribution, packagePath = `node_modules/${name}`) =>
  Object.freeze({ name, version, license, attribution, packagePath })

export const NOTICE_COMPONENTS = Object.freeze([
  packageComponent('Electron', '43.1.0', 'MIT', 'Electron contributors', 'node_modules/electron'),
  Object.freeze({ name: 'Chromium and bundled third-party code', version: 'Electron 43.1.0 distribution', license: 'Multiple', attribution: 'Chromium authors and third-party contributors' }),
  packageComponent('react', '19.2.7', 'MIT', 'Meta Platforms, Inc. and affiliates'),
  packageComponent('react-dom', '19.2.7', 'MIT', 'Meta Platforms, Inc. and affiliates'),
  packageComponent('scheduler', '0.27.0', 'MIT', 'Meta Platforms, Inc. and affiliates'),
  packageComponent('lucide-react', '1.24.0', 'ISC and MIT', 'Lucide Icons and Contributors; Cole Bemis'),
  packageComponent('zod', '4.4.3', 'MIT', 'Colin McDonnell'),
  packageComponent('@anthropic-ai/claude-agent-sdk', '0.3.270', 'SEE LICENSE IN README.md', 'Anthropic PBC'),
  packageComponent('@xterm/xterm', '6.0.0', 'MIT', 'The xterm.js authors; SourceLair Private Company; Christopher Jeffrey'),
  packageComponent('@xterm/addon-fit', '0.11.0', 'MIT', 'The xterm.js authors'),
  packageComponent('@xterm/addon-webgl', '0.19.0', 'MIT', 'The xterm.js authors'),
  packageComponent('node-pty', '1.1.0', 'MIT', 'Christopher Jeffrey; Daniel Imms; Microsoft Corporation'),
  packageComponent('node-addon-api', '7.1.1', 'MIT', 'Node.js API collaborators'),
  // Compiled into the main-process bundle, so their code ships inside app.asar
  // even though npm records them as development dependencies.
  packageComponent('electron-updater', '6.8.9', 'MIT', 'Loopline Systems and electron-builder contributors'),
  packageComponent('builder-util-runtime', '9.7.0', 'MIT', 'Loopline Systems and electron-builder contributors'),
  packageComponent('fs-extra', '10.1.0', 'MIT', 'JP Richardson'),
  packageComponent('graceful-fs', '4.2.11', 'ISC', 'Isaac Z. Schlueter, Ben Noordhuis, and Contributors'),
  packageComponent('jsonfile', '6.2.1', 'MIT', 'JP Richardson'),
  packageComponent('universalify', '2.0.1', 'MIT', 'Ryan Zimmerman'),
  packageComponent('js-yaml', '4.3.0', 'MIT', 'Vitaly Puzrin'),
  packageComponent('lazy-val', '1.0.5', 'MIT', 'Vladimir Krivosheev'),
  packageComponent('lodash.escaperegexp', '4.1.2', 'MIT', 'jQuery Foundation and other contributors'),
  packageComponent('lodash.isequal', '4.5.0', 'MIT', 'JS Foundation and other contributors'),
  packageComponent('semver', '7.7.4', 'ISC', 'Isaac Z. Schlueter and Contributors', 'node_modules/electron-updater/node_modules/semver'),
  packageComponent('sax', '1.6.0', 'BlueOak-1.0.0', 'Isaac Z. Schlueter and sax-js contributors'),
  packageComponent('debug', '4.4.3', 'MIT', 'TJ Holowaychuk; Josh Junon'),
  packageComponent('ms', '2.1.3', 'MIT', 'Vercel, Inc.'),
  packageComponent('supports-color', '7.2.0', 'MIT', 'Sindre Sorhus'),
  packageComponent('has-flag', '4.0.0', 'MIT', 'Sindre Sorhus'),
  packageComponent('@huggingface/transformers', '4.2.0', 'Apache-2.0', 'Hugging Face'),
  Object.freeze({ name: '@huggingface/jinja', version: '0.5.6', license: 'MIT', attribution: 'Hugging Face' }),
  packageComponent('@huggingface/tokenizers', '0.1.3', 'Apache-2.0', 'Hugging Face'),
  packageComponent('onnxruntime-web', '1.26.0-dev.20260416-b7804b056c', 'MIT', 'Microsoft Corporation'),
  packageComponent('onnxruntime-common', '1.24.0-dev.20251116-b39e144322', 'MIT', 'Microsoft Corporation', 'node_modules/onnxruntime-web/node_modules/onnxruntime-common'),
  packageComponent('flatbuffers', '25.9.23', 'Apache-2.0', 'Google LLC and contributors'),
  packageComponent('guid-typescript', '1.0.9', 'ISC', 'NicolasDeveloper contributors'),
  packageComponent('long', '5.3.2', 'Apache-2.0', 'Daniel Wirtz and contributors'),
  packageComponent('platform', '1.3.6', 'MIT', 'Benjamin Tan; John-David Dalton'),
  packageComponent('protobufjs', '7.6.5', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/aspromise', '1.1.2', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/base64', '1.1.2', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/codegen', '2.0.5', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/eventemitter', '1.1.1', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/fetch', '1.1.1', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/float', '1.0.2', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/path', '1.1.2', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/pool', '1.1.0', 'BSD-3-Clause', 'Daniel Wirtz'),
  packageComponent('@protobufjs/utf8', '1.1.2', 'BSD-3-Clause', 'Daniel Wirtz'),
  // Markdown answers and highlighted code on the Threads page, bundled into the renderer.
  packageComponent('@ungap/structured-clone', '1.4.0', 'ISC', 'Andrea Giammarchi'),
  packageComponent('bail', '2.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('ccount', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('comma-separated-tokens', '2.0.3', 'MIT', 'Titus Wormer'),
  packageComponent('decode-named-character-reference', '1.3.0', 'MIT', 'Titus Wormer'),
  packageComponent('devlop', '1.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('escape-string-regexp', '5.0.0', 'MIT', 'Sindre Sorhus', 'node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp'),
  packageComponent('estree-util-is-identifier-name', '3.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('extend', '3.0.2', 'MIT', 'Stefan Thomas'),
  packageComponent('hast-util-to-jsx-runtime', '2.3.6', 'MIT', 'Titus Wormer'),
  packageComponent('hast-util-whitespace', '3.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('highlight.js', '11.11.2', 'BSD-3-Clause', 'Ivan Sagalaev'),
  packageComponent('html-url-attributes', '3.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('inline-style-parser', '0.2.7', 'MIT', 'TJ Holowaychuk'),
  packageComponent('is-plain-obj', '4.1.0', 'MIT', 'Sindre Sorhus'),
  packageComponent('longest-streak', '3.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('lowlight', '3.3.0', 'MIT', 'Titus Wormer'),
  packageComponent('markdown-table', '3.0.4', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-find-and-replace', '3.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-from-markdown', '2.0.3', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm', '3.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm-autolink-literal', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm-footnote', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm-strikethrough', '2.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm-table', '2.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-gfm-task-list-item', '2.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-phrasing', '4.1.0', 'MIT', 'Titus Wormer; Victor Felder'),
  packageComponent('mdast-util-to-hast', '13.2.1', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-to-markdown', '2.1.2', 'MIT', 'Titus Wormer'),
  packageComponent('mdast-util-to-string', '4.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark', '4.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-core-commonmark', '2.0.3', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm', '3.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm-autolink-literal', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm-footnote', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm-strikethrough', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm-table', '2.1.2', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-extension-gfm-task-list-item', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-factory-destination', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-factory-label', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-factory-space', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-factory-title', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-factory-whitespace', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-character', '2.1.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-chunked', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-classify-character', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-combine-extensions', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-decode-numeric-character-reference', '2.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-decode-string', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-html-tag-name', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-normalize-identifier', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-resolve-all', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-sanitize-uri', '2.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('micromark-util-subtokenize', '2.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('property-information', '7.2.0', 'MIT', 'Titus Wormer'),
  packageComponent('react-markdown', '10.1.0', 'MIT', 'Espen Hovlandsdal'),
  packageComponent('remark-gfm', '4.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('remark-parse', '11.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('remark-rehype', '11.1.2', 'MIT', 'Titus Wormer'),
  packageComponent('space-separated-tokens', '2.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('style-to-js', '1.1.21', 'MIT', 'Menglin "Mark" Xu'),
  packageComponent('style-to-object', '1.0.14', 'MIT', 'Menglin "Mark" Xu'),
  packageComponent('trim-lines', '3.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('trough', '2.2.0', 'MIT', 'Titus Wormer'),
  packageComponent('unified', '11.0.5', 'MIT', 'Titus Wormer'),
  packageComponent('unist-util-is', '6.0.1', 'MIT', 'Titus Wormer'),
  packageComponent('unist-util-position', '5.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('unist-util-stringify-position', '4.0.0', 'MIT', 'Titus Wormer'),
  packageComponent('unist-util-visit', '5.1.0', 'MIT', 'Titus Wormer'),
  packageComponent('unist-util-visit-parents', '6.0.2', 'MIT', 'Titus Wormer'),
  packageComponent('vfile', '6.0.3', 'MIT', 'Titus Wormer'),
  packageComponent('vfile-message', '4.0.3', 'MIT', 'Titus Wormer'),
  // Mermaid diagrams in answers, bundled into a renderer chunk loaded on first use. khroma
  // declares no license in package.json; its license file is MIT.
  packageComponent('@braintree/sanitize-url', '7.1.2', 'MIT', 'Braintree'),
  packageComponent('@iconify/utils', '3.1.7', 'MIT', 'Vjacheslav Trushkin'),
  packageComponent('@mermaid-js/parser', '1.2.1', 'MIT', 'Yokozuna59 and Mermaid contributors'),
  packageComponent('@upsetjs/venn.js', '2.0.0', 'MIT', 'Ben Frederickson; Samuel Gratzl'),
  packageComponent('cose-base', '2.2.0', 'MIT', 'iVis@Bilkent', 'node_modules/cytoscape-fcose/node_modules/cose-base'),
  packageComponent('cose-base', '1.0.3', 'MIT', 'iVis@Bilkent'),
  packageComponent('cytoscape', '3.34.3', 'MIT', 'The Cytoscape Consortium'),
  packageComponent('cytoscape-cose-bilkent', '4.1.0', 'MIT', 'The Cytoscape Consortium'),
  packageComponent('cytoscape-fcose', '2.2.0', 'MIT', 'iVis-at-Bilkent'),
  packageComponent('d3-array', '3.2.4', 'ISC', 'Mike Bostock'),
  packageComponent('d3-array', '2.12.1', 'BSD-3-Clause', 'Mike Bostock', 'node_modules/d3-sankey/node_modules/d3-array'),
  packageComponent('d3-axis', '3.0.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-color', '3.1.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-dispatch', '3.0.1', 'ISC', 'Mike Bostock'),
  packageComponent('d3-ease', '3.0.1', 'BSD-3-Clause', 'Mike Bostock'),
  packageComponent('d3-format', '3.1.2', 'ISC', 'Mike Bostock'),
  packageComponent('d3-hierarchy', '3.1.2', 'ISC', 'Mike Bostock'),
  packageComponent('d3-interpolate', '3.0.1', 'ISC', 'Mike Bostock'),
  packageComponent('d3-path', '3.1.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-path', '1.0.9', 'BSD-3-Clause', 'Mike Bostock', 'node_modules/d3-sankey/node_modules/d3-path'),
  packageComponent('d3-sankey', '0.12.3', 'BSD-3-Clause', 'Mike Bostock'),
  packageComponent('d3-scale', '4.0.2', 'ISC', 'Mike Bostock'),
  packageComponent('d3-scale-chromatic', '3.1.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-selection', '3.0.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-shape', '3.2.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-shape', '1.3.7', 'BSD-3-Clause', 'Mike Bostock', 'node_modules/d3-sankey/node_modules/d3-shape'),
  packageComponent('d3-time', '3.1.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-time-format', '4.1.0', 'ISC', 'Mike Bostock'),
  packageComponent('d3-timer', '3.0.1', 'ISC', 'Mike Bostock'),
  packageComponent('d3-transition', '3.0.1', 'ISC', 'Mike Bostock'),
  packageComponent('d3-zoom', '3.0.0', 'ISC', 'Mike Bostock'),
  packageComponent('dagre-d3-es', '7.0.14', 'MIT', 'Thibaut Lassalle, David Newell, Alois Klink, Sidharth Vinod and dagre-es contributors; Chris Pettitt'),
  packageComponent('dayjs', '1.11.23', 'MIT', 'iamkun'),
  packageComponent('dompurify', '3.4.15', '(MPL-2.0 OR Apache-2.0)', 'Cure53 and other contributors'),
  packageComponent('es-toolkit', '1.52.0', 'MIT', 'Viva Republica, Inc.'),
  packageComponent('fastdom', '1.0.12', 'MIT', 'Wilson Page'),
  packageComponent('internmap', '2.0.3', 'ISC', 'Mike Bostock'),
  packageComponent('internmap', '1.0.1', 'ISC', 'Mike Bostock', 'node_modules/d3-sankey/node_modules/internmap'),
  packageComponent('katex', '0.16.47', 'MIT', 'Khan Academy and other contributors'),
  Object.freeze({ name: 'khroma', version: '2.1.0', license: 'MIT', attribution: 'Fabio Spampinato, Andrew Maney' }),
  packageComponent('layout-base', '2.0.1', 'MIT', 'iVis@Bilkent', 'node_modules/cytoscape-fcose/node_modules/layout-base'),
  packageComponent('layout-base', '1.0.2', 'MIT', 'iVis@Bilkent'),
  packageComponent('lodash-es', '4.18.1', 'MIT', 'OpenJS Foundation and other contributors'),
  packageComponent('marked', '16.4.2', 'MIT', 'MarkedJS; Christopher Jeffrey; John Gruber'),
  packageComponent('mermaid', '11.17.2', 'MIT', 'Knut Sveidqvist and Mermaid contributors'),
  packageComponent('roughjs', '4.6.6', 'MIT', 'Preet Shihn'),
  packageComponent('stylis', '4.4.0', 'MIT', 'Sultan Tarimo'),
  packageComponent('ts-dedent', '2.3.0', 'MIT', 'Tamino Martinius'),
  packageComponent('uuid', '14.0.2', 'MIT', 'Robert Kieffer and other contributors'),
  Object.freeze({ name: 'Manrope', nameSuffix: ' (font, latin + latin-ext woff2 subsets)', version: 'v20 (Google Fonts static serving)', license: 'OFL-1.1', attribution: 'The Manrope Project Authors' }),
  Object.freeze({ name: 'Spline Sans Mono', nameSuffix: ' (font, latin woff2 subset)', version: 'v13 (Google Fonts static serving)', license: 'OFL-1.1', attribution: 'The Spline Sans Mono Project Authors' }),
  Object.freeze({ name: 'Figtree', nameSuffix: ' (font, latin + latin-ext woff2 subsets)', version: 'v9 (Google Fonts static serving)', license: 'OFL-1.1', attribution: 'The Figtree Project Authors' }),
  Object.freeze({ name: 'T3 Code', nameSuffix: ' (provider icon paths adapted in ProviderMark.tsx)', version: 'd1d15c67 (apps/web/src/components/Icons.tsx)', license: 'MIT', attribution: 'T3 Tools Inc.' }),
  Object.freeze({ name: 'T3 Code', nameSuffix: ' (theme palettes, file format, editor, inspector and Open VSX client adapted in src/shared/themes, src/main/themes and settings/themes)', version: 'd1d15c67 (packages/shared/src/themePalettes.ts, apps/web/src/themePalette.ts, apps/web/src/components/settings/Theme*.tsx, themeInspector.ts, apps/web/src/openVsxThemes.ts, apps/web/src/vscodeThemeImport.ts)', license: 'MIT', attribution: 'T3 Tools Inc.' }),
])

export const EMBEDDED_BROWSER_DEPENDENCIES = Object.freeze([
  '@huggingface/jinja',
  '@huggingface/tokenizers',
  'onnxruntime-web',
  'onnxruntime-common',
  'flatbuffers',
  'guid-typescript',
  'long',
  'platform',
  'protobufjs',
  '@protobufjs/aspromise',
  '@protobufjs/base64',
  '@protobufjs/codegen',
  '@protobufjs/eventemitter',
  '@protobufjs/fetch',
  '@protobufjs/float',
  '@protobufjs/path',
  '@protobufjs/pool',
  '@protobufjs/utf8',
])

function fail(message) {
  throw new Error(`Third-party notice verification failed: ${message}`)
}

function normalizeLicense(value) {
  return Array.isArray(value) ? value.map((entry) => entry.type ?? entry).join(' OR ') : value
}

export async function verifyThirdPartyNotices(options = {}) {
  const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const names = new Set(NOTICE_COMPONENTS.map((component) => component.name))

  for (const component of NOTICE_COMPONENTS) {
    const marker = `| \`${component.name}\`${component.nameSuffix ?? ''} | \`${component.version}\` |`
    if (!notices.includes(marker) || !notices.includes(component.attribution)) {
      fail(`missing component evidence for ${component.name}`)
    }
    if (!component.packagePath) continue
    const packageJsonPath = join(root, component.packagePath, 'package.json')
    if (!existsSync(packageJsonPath)) fail(`missing package metadata for ${component.name}`)
    const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (metadata.version !== component.version) fail(`version drift for ${component.name}`)
    const expectedLicense = component.license === 'ISC and MIT' ? 'ISC' : component.license
    if (normalizeLicense(metadata.license) !== expectedLicense) fail(`license drift for ${component.name}`)
    const lockEntry = lock.packages?.[component.packagePath]
    if (lockEntry?.version !== component.version) fail(`lockfile drift for ${component.name}`)
    if (normalizeLicense(lockEntry.license) !== expectedLicense) fail(`lockfile license drift for ${component.name}`)
  }

  for (const embedded of EMBEDDED_BROWSER_DEPENDENCIES) {
    if (!names.has(embedded)) fail(`embedded dependency is not inventoried: ${embedded}`)
  }

  const transformersBundle = await readFile(
    join(root, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js'),
    'utf8',
  )
  for (const marker of [
    '@huggingface+tokenizers@0.1.3',
    '@huggingface+jinja@0.5.6',
    'from "onnxruntime-web/webgpu"',
    'from "onnxruntime-common"',
  ]) if (!transformersBundle.includes(marker)) fail(`Transformers bundle evidence is missing ${marker}`)

  const declaredEmbedded = new Set([
    ...Object.keys(JSON.parse(await readFile(join(root, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')).dependencies ?? {}),
    ...Object.keys(JSON.parse(await readFile(join(root, 'node_modules', 'protobufjs', 'package.json'), 'utf8')).dependencies ?? {}),
  ])
  for (const dependency of declaredEmbedded) {
    if (dependency === '@types/node') continue
    if (!names.has(dependency)) fail(`declared browser dependency is not inventoried: ${dependency}`)
  }

  // The renderer and its workers are built in separate rollup passes, and both
  // land in app.asar, so the evidence is the union of the two inventories.
  const bundleInventoryPath = join(root, 'out', 'renderer', 'bundled-dependencies.json')
  const workerInventoryPath = join(root, 'out', 'renderer', 'bundled-dependencies.worker.json')
  if (existsSync(bundleInventoryPath)) {
    const readPackages = async (path) =>
      existsSync(path) ? JSON.parse(await readFile(path, 'utf8')).packages ?? [] : []
    const bundled = new Set([
      ...(await readPackages(bundleInventoryPath)),
      ...(await readPackages(workerInventoryPath)),
    ])
    for (const packageName of bundled) {
      if (!names.has(packageName)) fail(`rendered bundle dependency is not inventoried: ${packageName}`)
    }
    for (const required of ['@huggingface/transformers', 'lucide-react', 'react', 'react-dom', 'react-markdown', 'remark-gfm', 'lowlight', 'mermaid', 'dompurify', 'scheduler', 'zod']) {
      if (!bundled.has(required)) fail(`bundle evidence is missing ${required}`)
    }
  }

  // The main process compiles the updater in, so app.asar redistributes that whole
  // module tree; the same inventory rule the renderer follows has to cover it.
  const mainInventoryPath = join(root, 'out', 'main', 'bundled-dependencies.json')
  if (existsSync(mainInventoryPath)) {
    const mainInventory = JSON.parse(await readFile(mainInventoryPath, 'utf8'))
    for (const packageName of mainInventory.packages ?? []) {
      if (!names.has(packageName)) fail(`main bundle dependency is not inventoried: ${packageName}`)
    }
    for (const required of ['builder-util-runtime', 'electron-updater']) {
      if (!mainInventory.packages?.includes(required)) fail(`main bundle evidence is missing ${required}`)
    }
  }

  // Standalone archives redistribute the external host dependency closure, too.
  const hostInventoryPath = join(root, 'out', 'host', 'external-dependencies.json')
  if (existsSync(hostInventoryPath)) {
    const inventory = JSON.parse(await readFile(hostInventoryPath, 'utf8'))
    for (const name of [...inventory.imports, ...inventory.dynamicImports]) {
      if (!name.startsWith('node:') && !names.has(name)) fail(`host dependency is not inventoried: ${name}`)
    }
    const bundledPath = join(root, 'out', 'host', 'bundled-dependencies.json')
    for (const name of JSON.parse(await readFile(bundledPath, 'utf8')).packages) {
      if (!names.has(name)) fail(`host bundle dependency is not inventoried: ${name}`)
    }
  }

  for (const requiredText of [
    '## Electron MIT license',
    '## Lucide ISC and Feather MIT licenses',
    '## Apache License 2.0',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '## Protocol Buffers BSD 3-Clause license',
    'Neither the name of its author, nor the names of its contributors',
    '## ONNX Runtime MIT license',
    'Copyright (c) Microsoft Corporation. All rights reserved.',
    '## Windows updater dependency MIT licenses',
    'Copyright (c) 2015 Loopline Systems',
    '## Windows updater dependency ISC licenses',
    '## sax Blue Oak Model License 1.0.0',
    'https://blueoakcouncil.org/license/1.0.0',
    '## Manrope SIL Open Font License 1.1',
    '## Spline Sans Mono SIL Open Font License 1.1',
    '## Figtree SIL Open Font License 1.1',
    '## Markdown rendering MIT licenses',
    'Copyright (c) Espen Hovlandsdal',
    '## Markdown rendering ISC license',
    '## highlight.js BSD 3-Clause license',
    '## Mermaid diagram MIT licenses',
    'Copyright (c) 2014 - 2022 Knut Sveidqvist',
    '## Mermaid diagram ISC licenses',
    '## DOMPurify Apache License 2.0',
    '## marked license',
    'Copyright © 2004, John Gruber',
    'Copyright (c) 2006, Ivan Sagalaev.',
    '## T3 Code MIT license',
    '## xterm.js MIT licenses',
    '## Native terminal MIT licenses',
    'Copyright (c) 2011-2016 Ryan Prichard',
    'Copyright (c) 2016, Daniel Imms',
    'Copyright (c) 2017 [Node.js API collaborators]',
    'Copyright (c) 2026 T3 Tools Inc.',
    'Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)',
  ]) if (!notices.includes(requiredText)) fail(`missing required license text: ${requiredText}`)

  if (options.licenseRoot) {
    for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      const path = join(options.licenseRoot, file)
      if (!existsSync(path) || readFileSync(path).length < 100) fail(`missing packaged ${file}`)
    }
  }

  return { componentCount: NOTICE_COMPONENTS.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyThirdPartyNotices()
  process.stdout.write(`Verified ${result.componentCount} third-party notice components.\n`)
}
