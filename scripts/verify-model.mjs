import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  MODEL_FILE_ALLOWLIST,
  RUNTIME_FILE_ALLOWLIST,
  validateBundledManifest,
  validateCatalogLock,
  validateRuntimeManifest,
} from './model-catalog.mjs'

const root = resolve(import.meta.dirname, '..')
const modelRoot = join(root, 'resources', 'models'); const runtimeRoot = join(root, 'resources', 'runtime')
const fail = (message) => { throw new Error(`Model verification failed: ${message}`) }
const safeRelative = (value) => typeof value === 'string' && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..')

async function json(path) { try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) fail('invalid lock file'); return JSON.parse(await readFile(path, 'utf8')) } catch { fail('invalid lock file') } }
async function hash(path, maximumBytes) { const value = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > maximumBytes) fail('size mismatch'); value.update(chunk) } return { bytes, sha256: value.digest('hex') } }
async function allFiles(directory, base = directory) { const output = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); const info = await lstat(path); if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail('unsafe filesystem entry'); if (info.isDirectory()) output.push(...await allFiles(path, base)); else output.push(relative(base, path).split(sep).join('/')) } return output.sort() }
async function checkFile(base, file) { if (!safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('invalid file record'); const target = resolve(base, ...file.path.split('/')); const actualBase = await realpath(base); const actual = await realpath(target).catch(() => fail('missing file')); if (actual !== actualBase && !actual.startsWith(`${actualBase}${sep}`)) fail('file escaped root'); const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) fail('size mismatch'); const integrity = await hash(target, file.bytes); if (integrity.bytes !== file.bytes) fail('size mismatch'); if (integrity.sha256 !== file.sha256) fail('SHA-256 mismatch') }
async function checkRoot(path) { const info = await lstat(path).catch(() => fail('missing asset root')); if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe asset root') }

export async function verifyPreparedAssets(options = {}) {
  const selectedModelRoot = options.modelRoot ?? modelRoot
  const selectedRuntimeRoot = options.runtimeRoot ?? runtimeRoot
  await checkRoot(selectedModelRoot); await checkRoot(selectedRuntimeRoot)
  const catalog = await json(join(selectedModelRoot, 'catalog.lock.json')); const manifest = await json(join(selectedModelRoot, 'manifest.lock.json'))
  try { validateCatalogLock(catalog); validateBundledManifest(manifest, catalog) } catch { fail('catalog or manifest drift') }
  const balanced = catalog.presets.balanced
  const expectedModelFiles = ['catalog.lock.json', 'manifest.lock.json', ...MODEL_FILE_ALLOWLIST.map((path) => `${balanced.repository}/${path}`)].sort()
  if (JSON.stringify(await allFiles(selectedModelRoot)) !== JSON.stringify(expectedModelFiles)) fail('unexpected model files')
  for (const file of manifest.files) await checkFile(join(selectedModelRoot, balanced.repository), file)

  const runtime = await json(join(selectedRuntimeRoot, 'manifest.lock.json'))
  try { validateRuntimeManifest(runtime) } catch { fail('runtime manifest drift') }
  if (JSON.stringify(await allFiles(selectedRuntimeRoot)) !== JSON.stringify(['manifest.lock.json', ...RUNTIME_FILE_ALLOWLIST].sort())) fail('unexpected runtime files')
  for (const file of runtime.files) await checkFile(selectedRuntimeRoot, file)
  return { modelFiles: manifest.files.length, runtimeFiles: runtime.files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyPreparedAssets()
  process.stdout.write(`Verified ${result.modelFiles} model files and ${result.runtimeFiles} runtime files.\n`)
}
