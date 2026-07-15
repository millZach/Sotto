import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL, URL } from 'node:url'

import { MODEL_CATALOG, MODEL_FILE_ALLOWLIST, RUNTIME_FILE_ALLOWLIST, modelFileUrl } from './model-catalog.mjs'
import { verifyPreparedAssets } from './verify-model.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const modelRoot = join(projectRoot, 'resources', 'models')
const runtimeRoot = join(projectRoot, 'resources', 'runtime')
const allowedRedirectHosts = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co', 'cas-server.xethub.hf.co'])

function finiteError(message) { return new Error(`Model preparation failed: ${message}`) }

async function fetchPinned(url, options = {}) {
  let current = new URL(url)
  if (current.protocol !== 'https:' || current.hostname !== 'huggingface.co' || current.username || current.password || current.port || current.pathname.includes('/main/')) throw finiteError('unsafe source')
  const visited = new Set([current.href])
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const { timeoutMs = 60_000, ...fetchOptions } = options
    const response = await globalThis.fetch(current, { ...fetchOptions, redirect: 'manual', signal: globalThis.AbortSignal.timeout(timeoutMs) })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location'); if (!location) throw finiteError('invalid redirect')
    await response.body?.cancel().catch(() => undefined)
    const next = new URL(location, current)
    if (next.protocol !== 'https:' || !allowedRedirectHosts.has(next.hostname) || next.username || next.password || next.port || visited.has(next.href)) throw finiteError('unsafe redirect')
    visited.add(next.href)
    current = next
  }
  throw finiteError('too many redirects')
}

async function treeMetadata(model) {
  const url = `https://huggingface.co/api/models/${model.repository}/tree/${model.revision}?recursive=true&expand=true`
  const response = await fetchPinned(url)
  if (!response.ok) throw finiteError('metadata unavailable')
  const entries = await response.json()
  if (!Array.isArray(entries)) throw finiteError('invalid metadata')
  return new Map(entries.map((entry) => [entry.path, entry]))
}

async function hashFile(path) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk) }
  return { bytes, sha256: hash.digest('hex') }
}

async function download(url, destination, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw finiteError('invalid expected size')
  await mkdir(dirname(destination), { recursive: true })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchPinned(url, { timeoutMs: 600_000 })
      if (!response.ok || !response.body) throw finiteError('download unavailable')
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) !== expectedBytes) throw finiteError('download size mismatch')
      let received = 0
      const limiter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; callback(received > expectedBytes ? finiteError('download size mismatch') : null, chunk) } })
      await pipeline(response.body, limiter, createWriteStream(destination, { flags: 'wx' }))
      const integrity = await hashFile(destination)
      if (integrity.bytes !== expectedBytes) throw finiteError('download size mismatch')
      return integrity
    } catch (error) {
      await rm(destination, { force: true })
      if (attempt === 3) throw error
    }
  }
  throw finiteError('download unavailable')
}

async function metadataForFile(model, path, entry, scratch) {
  const size = entry?.lfs?.size ?? entry?.size
  const oid = entry?.lfs?.oid
  if (typeof oid === 'string' && /^[a-f0-9]{64}$/.test(oid) && Number.isSafeInteger(size) && size >= 0) return { bytes: size, sha256: oid }
  const destination = join(scratch, model.repository, ...path.split('/'))
  if (!Number.isSafeInteger(size) || size < 0) throw finiteError('invalid metadata size')
  return download(modelFileUrl(model, path), destination, size)
}

const directoryOperations = {
  rename,
  rm,
  exists: (path) => stat(path).then(() => true, (error) => { if (error?.code === 'ENOENT') return false; throw error }),
}

export async function replacePreparedAssetSet(entries, operations = directoryOperations) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Asset promotion failed')
  const destinations = new Set(entries.map((entry) => resolve(entry.destination)))
  if (destinations.size !== entries.length) throw new Error('Asset promotion failed')
  for (const entry of entries) if (!(await operations.exists(entry.temporary))) throw new Error('Asset promotion failed')

  const states = entries.map((entry) => ({
    ...entry,
    backup: `${entry.destination}.backup-${randomUUID()}`,
    hadDestination: false,
    backedUp: false,
    promoted: false,
  }))
  try {
    for (const state of states) {
      state.hadDestination = await operations.exists(state.destination)
      if (state.hadDestination) {
        await operations.rename(state.destination, state.backup)
        state.backedUp = true
      }
    }
    for (const state of states) {
      await operations.rename(state.temporary, state.destination)
      state.promoted = true
    }
  } catch {
    for (const state of [...states].reverse()) {
      if (state.promoted) await operations.rm(state.destination, { recursive: true, force: true }).catch(() => undefined)
      if (state.backedUp) await operations.rename(state.backup, state.destination).catch(() => undefined)
    }
    throw new Error('Asset promotion failed')
  }
  for (const state of states) {
    if (state.backedUp) await operations.rm(state.backup, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function replaceDirectory(temporary, destination) {
  await replacePreparedAssetSet([{ temporary, destination }])
}

async function main() {
  await mkdir(dirname(modelRoot), { recursive: true })
  const temporary = `${modelRoot}.partial-${randomUUID()}`
  const scratch = `${modelRoot}.metadata-${randomUUID()}`
  const runtimeTemporary = `${runtimeRoot}.partial-${randomUUID()}`
  try {
    await mkdir(temporary, { recursive: true }); await mkdir(scratch, { recursive: true })
    const presets = {}
    for (const [preset, model] of Object.entries(MODEL_CATALOG)) {
      const tree = await treeMetadata(model); const files = []
      for (const path of MODEL_FILE_ALLOWLIST) {
        const entry = tree.get(path); if (!entry) throw finiteError('catalog file missing')
        const url = modelFileUrl(model, path)
        let integrity
        if (model.bundled) {
          const destination = join(temporary, model.repository, ...path.split('/'))
          const expectedBytes = entry?.lfs?.size ?? entry?.size
          integrity = await download(url, destination, expectedBytes)
        } else integrity = await metadataForFile(model, path, entry, scratch)
        if (path === 'onnx/encoder_model_quantized.onnx' && integrity.bytes !== model.encoderBytes) throw finiteError('encoder size mismatch')
        if (path === 'onnx/decoder_model_merged_quantized.onnx' && integrity.bytes !== model.decoderBytes) throw finiteError('decoder size mismatch')
        files.push({ path, url, bytes: integrity.bytes, sha256: integrity.sha256 })
      }
      presets[preset] = { repository: model.repository, revision: model.revision, license: model.license, bundled: model.bundled, files }
    }
    const catalog = { version: 1, presets }
    const balanced = presets.balanced
    const manifest = { version: 1, preset: 'balanced', repository: balanced.repository, revision: balanced.revision, files: balanced.files }
    await writeFile(join(temporary, 'catalog.lock.json'), `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' })
    await writeFile(join(temporary, 'manifest.lock.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await mkdir(runtimeTemporary, { recursive: true }); const runtimeFiles = []
    for (const name of RUNTIME_FILE_ALLOWLIST) {
      const source = join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist', name); const destination = join(runtimeTemporary, name)
      await copyFile(source, destination); const integrity = await hashFile(destination); runtimeFiles.push({ path: name, ...integrity })
    }
    await writeFile(join(runtimeTemporary, 'manifest.lock.json'), `${JSON.stringify({ version: 1, files: runtimeFiles }, null, 2)}\n`, { flag: 'wx' })
    await verifyPreparedAssets({ modelRoot: temporary, runtimeRoot: runtimeTemporary })
    await replacePreparedAssetSet([
      { temporary, destination: modelRoot },
      { temporary: runtimeTemporary, destination: runtimeRoot },
    ])
  } catch (error) { if (process.env.TALKTYPE_PREPARE_DEBUG === '1') process.stderr.write(`${String(error)}\n`); await rm(temporary, { recursive: true, force: true }); await rm(runtimeTemporary, { recursive: true, force: true }); throw finiteError(error?.message?.startsWith('Model preparation failed:') ? error.message.slice(26) : 'unexpected failure') }
  finally { await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
