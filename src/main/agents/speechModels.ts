import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { createHttpsDownloader, replaceDirectoryAtomic, type LockedFile, type ModelDownloader } from '../models/modelDownload'
import type { FileSource } from '../models/modelProtocol'
import manifestData from './speechModelManifest.json'

interface SpeechManifest {
  readonly version: number
  readonly repository: string
  readonly revision: string
  readonly license: string
  readonly files: readonly LockedFile[]
}

export interface NaturalSpeechModelStatus {
  readonly ready: boolean
  readonly completedBytes: number
  readonly totalBytes: number
}

interface NaturalSpeechModelOptions {
  readonly downloader?: ModelDownloader
}

function lockedManifest(input: SpeechManifest): SpeechManifest {
  if (input.version !== 1 || input.repository !== 'onnx-community/Supertonic-TTS-ONNX'
    || input.revision !== 'cff123c84b0655d9d647641f1b532c3cbb8f7faa' || input.license !== 'OpenRAIL-M'
    || input.files.length !== 20) throw new Error('Invalid natural voice manifest')
  const names = new Set<string>()
  for (const file of input.files) {
    const modelUrl = `https://huggingface.co/${input.repository}/resolve/${input.revision}/${file.path}`
    const licenseUrl = 'https://huggingface.co/Supertone/supertonic/resolve/b6856d033f622c63ea29441795be266a1133e227/LICENSE'
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file.path) || file.path.split('/').some(part => part === '.' || part === '..')
      || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || (file.url !== modelUrl && !(file.path === 'LICENSE' && file.url === licenseUrl))) {
      throw new Error('Invalid natural voice manifest')
    }
    names.add(file.path)
    Object.freeze(file)
  }
  Object.freeze(input.files)
  return Object.freeze(input)
}

const manifest = lockedManifest(structuredClone(manifestData))
const totalBytes = manifest.files.reduce((total, file) => total + file.bytes, 0)

/** Optional local speech assets. Only an explicit download() can access the network. */
export class NaturalSpeechModels {
  private readonly userRoot: string
  private readonly parent: string
  private readonly root: string
  private readonly downloader: ModelDownloader
  private operation: Promise<NaturalSpeechModelStatus> | null = null
  private verification: Promise<boolean> | null = null
  private fingerprint: string | null = null
  private completedBytes = 0
  private activeFile: { path: string; bytes: number } | null = null

  constructor(userRoot: string, options: NaturalSpeechModelOptions = {}) {
    this.userRoot = resolve(userRoot)
    this.parent = join(this.userRoot, 'onnx-community')
    this.root = join(this.userRoot, ...manifest.repository.split('/'))
    this.downloader = options.downloader ?? createHttpsDownloader()
  }

  async status(): Promise<NaturalSpeechModelStatus> {
    if (this.operation !== null) {
      const active = this.activeFile
      const completed = this.completedBytes
      const bytes = active === null ? 0 : await lstat(active.path).then(info =>
        info.isFile() && !info.isSymbolicLink() ? Math.min(info.size, active.bytes) : 0, () => 0)
      return { ready: false, completedBytes: Math.min(totalBytes, completed + bytes), totalBytes }
    }
    const ready = await this.verified()
    return { ready, completedBytes: ready ? totalBytes : 0, totalBytes }
  }

  download(): Promise<NaturalSpeechModelStatus> {
    if (this.operation !== null) return this.operation
    const operation = this.install()
    this.operation = operation
    void operation.finally(() => {
      if (this.operation === operation) this.operation = null
    }).catch(() => undefined)
    return operation
  }

  async protocolSources(): Promise<Record<string, FileSource>> {
    if (this.operation !== null || !(await this.verified())) return {}
    return { [manifest.repository]: {
      root: this.root, boundaryRoot: this.userRoot,
      files: new Set(manifest.files.map(file => file.path)),
    } }
  }

  private async install(): Promise<NaturalSpeechModelStatus> {
    let temporary: string | null = null
    this.completedBytes = 0
    try {
      if (await this.verified()) return { ready: true, completedBytes: totalBytes, totalBytes }
      await mkdir(this.userRoot, { recursive: true })
      await this.assertDirectory(this.userRoot)
      await mkdir(this.parent, { recursive: true })
      await this.assertDirectory(this.parent)
      await this.assertDestinationSafe()
      temporary = join(this.parent, `.Supertonic-TTS-ONNX.partial-${randomUUID()}`)
      await mkdir(temporary)
      await this.assertDirectory(temporary)
      for (const file of manifest.files) {
        const target = this.contained(temporary, file.path)
        await mkdir(dirname(target), { recursive: true })
        await this.assertDirectory(dirname(target))
        this.activeFile = { path: target, bytes: file.bytes }
        await this.downloader(file.url, target, file.bytes)
        if (!(await this.verifyFile(target, file))) throw new Error('Natural voice verification failed')
        this.completedBytes += file.bytes
        this.activeFile = null
      }
      // Recheck containment and the exact staged tree before any rename or removal.
      await this.treeFingerprint(temporary)
      await this.assertDirectory(this.parent)
      await this.assertDestinationSafe()
      await replaceDirectoryAtomic(temporary, this.root)
      temporary = null
      this.fingerprint = null
      if (!(await this.verified())) throw new Error('Natural voice verification failed')
      return { ready: true, completedBytes: totalBytes, totalBytes }
    } catch {
      throw new Error('Natural voice download failed. Check the connection and available disk space, then retry.')
    } finally {
      this.activeFile = null
      if (temporary !== null) await this.removeTemporary(temporary)
    }
  }

  private verified(): Promise<boolean> {
    if (this.verification !== null) return this.verification
    const operation = this.verifyInstallation()
    this.verification = operation
    void operation.finally(() => {
      if (this.verification === operation) this.verification = null
    }).catch(() => undefined)
    return operation
  }

  private async verifyInstallation(): Promise<boolean> {
    try {
      const before = await this.treeFingerprint(this.root)
      if (this.fingerprint === before) return true
      this.fingerprint = null
      for (const file of manifest.files) {
        if (!(await this.verifyFile(this.contained(this.root, file.path), file))) return false
      }
      if (await this.treeFingerprint(this.root) !== before) return false
      this.fingerprint = before
      return true
    } catch {
      this.fingerprint = null
      return false
    }
  }

  private async verifyFile(path: string, expected: LockedFile): Promise<boolean> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== expected.bytes) return false
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(path)) {
      const data = chunk as Buffer
      size += data.length
      if (size > expected.bytes) return false
      hash.update(data)
    }
    return size === expected.bytes && hash.digest('hex') === expected.sha256
  }

  private async treeFingerprint(root: string): Promise<string> {
    await this.assertDirectory(this.userRoot)
    await this.assertDirectory(this.parent)
    const hash = createHash('sha256')
    const paths = new Set(['', ...manifest.files.flatMap(file => {
      const parts = file.path.split('/')
      return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
    })])
    for (const path of [...paths].sort()) {
      const target = path ? this.contained(root, path) : root
      const info = await lstat(target, { bigint: true })
      if (info.isSymbolicLink()) throw new Error('Unsafe natural voice path')
      const file = manifest.files.find(entry => entry.path === path)
      if (file) {
        if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(file.bytes)) throw new Error('Incomplete natural voice model')
      } else {
        await this.assertDirectory(target)
        const expected = [...paths].filter(entry => entry !== path && (entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '') === path)
          .map(entry => entry.split('/').at(-1)!).sort()
        if ((await readdir(target)).sort().join('\0') !== expected.join('\0')) throw new Error('Unexpected natural voice files')
      }
      hash.update([path, info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join('\0'))
    }
    // Identity/timestamp changes force
    // fresh content hashing; asset protocol containment is checked again per request.
    return hash.digest('hex')
  }

  private contained(root: string, path: string): string {
    const target = resolve(root, ...path.split('/'))
    if (!target.startsWith(`${resolve(root)}${sep}`)) throw new Error('Unsafe natural voice path')
    return target
  }

  private async assertDirectory(path: string): Promise<void> {
    const [base, actual, info] = await Promise.all([realpath(this.userRoot), realpath(path), lstat(path)])
    if (!info.isDirectory() || info.isSymbolicLink() || (actual !== base && !actual.startsWith(`${base}${sep}`))) {
      throw new Error('Unsafe natural voice directory')
    }
  }

  private async assertDestinationSafe(): Promise<void> {
    const exists = await lstat(this.root).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (!exists) return
    await this.assertDirectory(this.root)
    // A repair may replace corrupt/missing expected files, but cannot remove unknown
    // files or recurse through links an outside process put in this directory.
    const allowed = new Set(manifest.files.map(file => file.path))
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      const entries = await readdir(directory)
      if (entries.length > manifest.files.length) throw new Error('Unsafe natural voice directory')
      for (const name of entries) {
        const relative = prefix ? `${prefix}/${name}` : name
        const path = this.contained(this.root, relative)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Unsafe natural voice path')
        if (info.isDirectory() && [...allowed].some(file => file.startsWith(`${relative}/`))) {
          await this.assertDirectory(path)
          await visit(path, relative)
        } else if (!info.isFile() || info.nlink !== 1 || !allowed.has(relative)) throw new Error('Unsafe natural voice path')
      }
    }
    await visit(this.root)
  }

  private async removeTemporary(path: string): Promise<void> {
    try {
      if (dirname(path) !== this.parent || !path.startsWith(join(this.parent, '.Supertonic-TTS-ONNX.partial-'))) return
      await this.assertDirectory(this.userRoot)
      await this.assertDirectory(this.parent)
      await this.assertDirectory(path)
      await rm(path, { recursive: true, force: true })
    } catch { /* Never recurse into a staging directory that escaped its boundary. */ }
  }
}
