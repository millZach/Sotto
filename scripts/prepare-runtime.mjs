import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { RUNTIME_FILE_ALLOWLIST } from './model-catalog.mjs'
import { verifyPreparedAssets } from './verify-runtime.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = join(projectRoot, 'resources', 'runtime')

async function hashFile(path) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk) }
  return { bytes, sha256: hash.digest('hex') }
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
  await mkdir(dirname(runtimeRoot), { recursive: true })
  const runtimeTemporary = `${runtimeRoot}.partial-${randomUUID()}`
  try {
    await mkdir(runtimeTemporary, { recursive: true })
    const runtimeFiles = []
    for (const name of RUNTIME_FILE_ALLOWLIST) {
      const source = join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist', name)
      const destination = join(runtimeTemporary, name)
      await copyFile(source, destination)
      runtimeFiles.push({ path: name, ...await hashFile(destination) })
    }
    await writeFile(join(runtimeTemporary, 'manifest.lock.json'), `${JSON.stringify({ version: 1, files: runtimeFiles }, null, 2)}\n`, { flag: 'wx' })
    await verifyPreparedAssets({ runtimeRoot: runtimeTemporary })
    await replaceDirectory(runtimeTemporary, runtimeRoot)
  } catch {
    await rm(runtimeTemporary, { recursive: true, force: true })
    throw new Error('Runtime preparation failed')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
