import { lstat, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const CACHE = 'Supertonic-TTS-ONNX'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const temporaryName = new RegExp(`^(?:\\.${CACHE}\\.partial-|${CACHE}\\.backup-)${UUID}$`, 'iu')
const files = new Set([
  'LICENSE', 'config.json', 'tokenizer.json', 'tokenizer_config.json',
  ...['text_encoder', 'latent_denoiser', 'voice_decoder'].flatMap(name => [`onnx/${name}.onnx`, `onnx/${name}.onnx_data`]),
  ...['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'].map(name => `voices/${name}.bin`),
])

async function safeDirectory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path)) throw new Error('Unsafe voice cache')
}

async function ownedTree(root: string, path = root): Promise<{ files: string[]; directories: string[] }> {
  await safeDirectory(path)
  const tree: { files: string[]; directories: string[] } = { files: [], directories: [] }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const name = relative(root, child).split(sep).join('/')
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw new Error('Unsafe voice cache')
    if (info.isFile() && files.has(name)) tree.files.push(child)
    else if (info.isDirectory() && ['onnx', 'voices'].includes(name)) {
      const nested = await ownedTree(root, child)
      tree.files.push(...nested.files)
      tree.directories.push(...nested.directories)
    } else throw new Error('Unknown voice cache entry')
  }
  tree.directories.push(path)
  return tree
}

export async function removeRetiredVoiceCache(directory: string): Promise<{ removed: number; retained: number; failed: number }> {
  const result = { removed: 0, retained: 0, failed: 0 }
  const boundary = resolve(directory)
  const models = join(boundary, 'models')
  const parent = join(models, 'onnx-community')
  let names: string[]
  let wakeDirectories: string[]
  try {
    await safeDirectory(boundary)
    const saved = JSON.parse(await readFile(join(boundary, 'agents.json'), 'utf8')) as { configuration?: Record<string, unknown> }
    const configuration = saved.configuration
    if (!configuration || !('wakeModelDirectory' in configuration || 'wakeRuntimeDirectory' in configuration)) return result
    wakeDirectories = [configuration.wakeModelDirectory, configuration.wakeRuntimeDirectory]
      .filter((path): path is string => typeof path === 'string' && isAbsolute(path)).map(path => resolve(path))
    wakeDirectories.push(...await Promise.all(wakeDirectories.map(path => realpath(path).catch(() => path))))
    await safeDirectory(models)
    await safeDirectory(parent)
    names = await readdir(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.failed++; console.warn('retired-voice-cache-cleanup-failed') }
    return result
  }
  for (const name of names.filter(name => name === CACHE || temporaryName.test(name))) {
    const root = resolve(parent, name)
    if (relative(parent, root) !== name || !root.startsWith(`${boundary}${sep}`)) { result.retained++; continue }
    const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
    const rootKey = pathKey(root)
    if (wakeDirectories.map(pathKey).some(path => path === rootKey || path.startsWith(`${rootKey}${sep}`) || rootKey.startsWith(`${path}${sep}`))) { result.retained++; continue }
    let tree: Awaited<ReturnType<typeof ownedTree>>
    try { tree = await ownedTree(root) }
    catch { result.retained++; continue }
    try {
      for (const path of tree.files) {
        await safeDirectory(parent)
        await safeDirectory(root)
        await safeDirectory(resolve(path, '..'))
        const entry = await lstat(path)
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe voice cache')
        await unlink(path)
      }
      for (const path of tree.directories) { await safeDirectory(path); await rmdir(path) }
      result.removed++
    } catch { result.failed++ }
  }
  if (result.retained) console.warn('retired-voice-cache-retained')
  if (result.failed) console.warn('retired-voice-cache-cleanup-failed')
  return result
}
