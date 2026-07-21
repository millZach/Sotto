import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  Object.freeze({ name: 'Xenova/whisper-base', version: '64da57285918e20ea79ea5c88eed7197933abaa8', license: 'Apache-2.0', attribution: 'Hugging Face and OpenAI Whisper contributors' }),
  Object.freeze({ name: 'Manrope', nameSuffix: ' (font, latin + latin-ext woff2 subsets)', version: 'v20 (Google Fonts static serving)', license: 'OFL-1.1', attribution: 'The Manrope Project Authors' }),
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

  const bundleInventoryPath = join(root, 'out', 'renderer', 'bundled-dependencies.json')
  if (existsSync(bundleInventoryPath)) {
    const bundleInventory = JSON.parse(await readFile(bundleInventoryPath, 'utf8'))
    for (const packageName of bundleInventory.packages ?? []) {
      if (!names.has(packageName)) fail(`rendered bundle dependency is not inventoried: ${packageName}`)
    }
    for (const required of ['@huggingface/transformers', 'lucide-react', 'react', 'react-dom', 'scheduler', 'zod']) {
      if (!bundleInventory.packages?.includes(required)) fail(`bundle evidence is missing ${required}`)
    }
  }

  const modelManifest = JSON.parse(await readFile(join(root, 'resources', 'models', 'manifest.lock.json'), 'utf8'))
  if (!notices.includes(modelManifest.revision) || modelManifest.repository !== 'Xenova/whisper-base') {
    fail('bundled model notice drift')
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
    '## Manrope SIL Open Font License 1.1',
    'onnx-community/moonshine-base-ONNX',
    'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
  ]) if (!notices.includes(requiredText)) fail(`missing required license text: ${requiredText}`)

  if (options.packagedResources) {
    const applicationRoot = dirname(options.packagedResources)
    for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      const path = join(applicationRoot, file)
      if (!existsSync(path) || readFileSync(path).length < 100) fail(`missing packaged ${file}`)
    }
  }

  return { componentCount: NOTICE_COMPONENTS.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyThirdPartyNotices()
  process.stdout.write(`Verified ${result.componentCount} third-party notice components.\n`)
}
