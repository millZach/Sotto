import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { get } from 'node:https'

import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  modelDisclosureCatalogSchema,
  type ModelDisclosureCatalog,
  type ModelStatus,
} from '../../shared/contracts'
import type { ModelPreset } from '../../shared/settings'
import type { FileSource } from './modelProtocol'

export interface LockedFile { readonly path: string; readonly url: string; readonly bytes: number; readonly sha256: string }
export interface LockedPreset { readonly repository: string; readonly revision: string; readonly license: 'Apache-2.0'; readonly bundled: boolean; readonly files: readonly LockedFile[] }
export interface CatalogLock { readonly version: 1; readonly presets: Readonly<Record<ModelPreset, LockedPreset>> }
export interface BundledModelManifest {
  readonly version: 1
  readonly preset: 'balanced'
  readonly repository: string
  readonly revision: string
  readonly files: readonly LockedFile[]
}
export interface ModelProgress { readonly preset: ModelPreset; readonly completedBytes: number; readonly totalBytes: number }
export type ModelDownloader = (url: string, destination: string, expectedBytes: number) => Promise<void>

export interface ModelManagerOptions {
  readonly catalog: CatalogLock
  readonly bundledManifest: BundledModelManifest
  readonly packagedRoot: string
  readonly userRoot: string
  readonly downloader?: ModelDownloader
  readonly onProgress?: (progress: ModelProgress) => void
  readonly verifyFile?: (path: string, expected: LockedFile) => Promise<boolean>
}

const PRESETS = ['fast', 'balanced', 'accurate'] as const
const SHA = /^[a-f0-9]{64}$/
const REV = /^[a-f0-9]{40}$/
const FILE_ALLOWLIST = ['added_tokens.json', 'config.json', 'generation_config.json', 'merges.txt', 'normalizer.json', 'onnx/decoder_model_merged_quantized.onnx', 'onnx/encoder_model_quantized.onnx', 'preprocessor_config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'] as const
const EXPECTED = {
  fast: { repository: 'Xenova/whisper-tiny', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', bundled: false, encoder: 10_124_910, decoder: 30_727_765 },
  balanced: { repository: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8', bundled: true, encoder: 23_200_850, decoder: 53_707_539 },
  accurate: { repository: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13', bundled: false, encoder: 92_324_809, decoder: 156_780_950 },
} as const

function validateCatalog(value: CatalogLock): CatalogLock {
  if (value?.version !== 1 || !value.presets || Object.keys(value).sort().join() !== ['presets', 'version'].join() || Object.keys(value.presets).sort().join() !== [...PRESETS].sort().join()) throw new Error('Invalid model catalog')
  for (const preset of PRESETS) {
    const model = value.presets[preset]
    const expectedModel = EXPECTED[preset]
    if (!model || !REV.test(model.revision) || model.license !== 'Apache-2.0' || !Array.isArray(model.files) || model.files.length === 0) throw new Error('Invalid model catalog')
    if (Object.keys(model).sort().join() !== ['bundled', 'files', 'license', 'repository', 'revision'].join()) throw new Error('Invalid model catalog')
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model.repository)) throw new Error('Invalid model catalog')
    if (model.repository !== expectedModel.repository || model.revision !== expectedModel.revision || model.bundled !== expectedModel.bundled || model.files.map((file) => file.path).join() !== FILE_ALLOWLIST.join()) throw new Error('Invalid model catalog')
    const seen = new Set<string>()
    for (const file of model.files) {
      if (!file || Object.keys(file).sort().join() !== ['bytes', 'path', 'sha256', 'url'].join() || seen.has(file.path) || file.path.includes('\\') || file.path.split('/').some((part: string) => !part || part === '.' || part === '..') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA.test(file.sha256)) throw new Error('Invalid model catalog')
      seen.add(file.path)
      const expected = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`
      if (file.url !== expected) throw new Error('Invalid model catalog')
    }
    const encoder = model.files.find((file) => file.path.includes('encoder_model'))
    const decoder = model.files.find((file) => file.path.includes('decoder_model'))
    if (encoder?.bytes !== expectedModel.encoder || decoder?.bytes !== expectedModel.decoder) throw new Error('Invalid model catalog')
  }
  if (!value.presets.balanced.bundled || value.presets.fast.bundled || value.presets.accurate.bundled) throw new Error('Invalid model catalog')
  return value
}

function validateBundledModelManifest(value: BundledModelManifest, catalog: CatalogLock): BundledModelManifest {
  const balanced = catalog.presets.balanced
  if (!value
    || Object.keys(value).sort().join() !== ['files', 'preset', 'repository', 'revision', 'version'].join()
    || value.version !== 1
    || value.preset !== 'balanced'
    || value.repository !== balanced.repository
    || value.revision !== balanced.revision
    || !Array.isArray(value.files)
    || JSON.stringify(value.files) !== JSON.stringify(balanced.files)) throw new Error('Invalid bundled model manifest')
  return value
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export async function readBoundedJsonFile(
  path: string,
  options: {
    readonly maximumBytes?: number
    readonly beforeRead?: () => void | Promise<void>
  } = {},
): Promise<unknown> {
  const maximumBytes = options.maximumBytes ?? 1_000_000
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('Invalid model manifest')
  const pathInfo = await lstat(path)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > maximumBytes) throw new Error('Invalid model manifest')
  const handle = await open(path, 'r')
  try {
    const handleInfo = await handle.stat()
    if (!handleInfo.isFile() || handleInfo.size > maximumBytes) throw new Error('Invalid model manifest')
    await options.beforeRead?.()
    const content = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maximumBytes) throw new Error('Invalid model manifest')
    return JSON.parse(content.subarray(0, offset).toString('utf8')) as unknown
  } finally {
    await handle.close()
  }
}

export async function loadCatalogLock(path: string): Promise<CatalogLock> {
  return validateCatalog(await readBoundedJsonFile(path) as CatalogLock)
}

export async function loadBundledModelManifest(
  path: string,
  catalog: CatalogLock,
): Promise<BundledModelManifest> {
  try {
    const validatedCatalog = validateCatalog(structuredClone(catalog))
    const manifest = await readBoundedJsonFile(path) as BundledModelManifest
    return deepFreeze(validateBundledModelManifest(manifest, validatedCatalog))
  } catch {
    throw new Error('Invalid bundled model manifest')
  }
}

async function shaFile(path: string, maximumBytes: number): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0
  await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > maximumBytes) callback(new Error('Model verification failed')); else { hash.update(chunk); callback() } } }))
  return { bytes, sha256: hash.digest('hex') }
}

interface HttpsResponse extends Readable {
  readonly statusCode?: number
  readonly headers: { readonly location?: string; readonly 'content-length'?: string }
}

interface HttpsRequest {
  setTimeout(milliseconds: number, callback: () => void): unknown
  once(event: 'error', callback: (error: Error) => void): unknown
  destroy(error?: Error): unknown
}

export type HttpsGet = (url: URL, callback: (response: HttpsResponse) => void) => HttpsRequest
export interface DownloadTimer {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}

const downloadTimer: DownloadTimer = {
  set(callback, milliseconds) { const handle = setTimeout(callback, milliseconds); handle.unref(); return handle },
  clear(handle) { clearTimeout(handle as NodeJS.Timeout) },
}

export function createHttpsDownloader(
  requestGet: HttpsGet = get as HttpsGet,
  timeout: { readonly requestMs?: number; readonly overallMs?: number; readonly timer?: DownloadTimer } = {},
): ModelDownloader {
  return async (url, destination, expectedBytes) => {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Model download failed') }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'huggingface.co' || parsed.username || parsed.password || parsed.port || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('Model download failed')
    await mkdir(dirname(destination), { recursive: true })
    const output = await open(destination, 'wx')
    let succeeded = false
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const visited = new Set([parsed.href])
        let settled = false
        let activeRequest: HttpsRequest | null = null
        let activeResponse: HttpsResponse | null = null
        let deadline: unknown | null = null
        const timer = timeout.timer ?? downloadTimer
        const clearDeadline = (): void => {
          if (deadline === null) return
          const handle = deadline
          deadline = null
          try { timer.clear(handle) } catch { /* cleanup is best effort */ }
        }
        const cancelResponse = (response: HttpsResponse | null): void => {
          if (response === null) return
          response.once('error', () => undefined)
          try { response.destroy() } catch { /* cleanup is best effort */ }
        }
        const cancelRequest = (request: HttpsRequest | null): void => {
          if (request === null) return
          try { request.destroy() } catch { /* cleanup is best effort */ }
        }
        const resolve = (): void => {
          if (settled) return
          settled = true
          activeRequest = null
          activeResponse = null
          clearDeadline()
          resolvePromise()
        }
        const reject = (): void => {
          if (settled) return
          settled = true
          const response = activeResponse
          const request = activeRequest
          activeResponse = null
          activeRequest = null
          clearDeadline()
          cancelResponse(response)
          cancelRequest(request)
          rejectPromise(new Error('Model download failed'))
        }
        const request = (current: URL, redirects: number): void => {
          if (settled) return
          let operation: HttpsRequest
          let pendingResponse: HttpsResponse | null = null
          let ready = false
          const handleResponse = (response: HttpsResponse): void => {
            if (settled) { cancelResponse(response); return }
            activeResponse = response
            response.once('error', () => { if (activeResponse === response) reject() })
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              const location = response.headers.location
              const redirectRequest = activeRequest
              activeResponse = null
              activeRequest = null
              cancelResponse(response)
              cancelRequest(redirectRequest)
              if (!location) { reject(); return }
              let next: URL
              try { next = validateDownloadRedirect(current.href, location, redirects) } catch { reject(); return }
              if (visited.has(next.href)) { reject(); return }
              visited.add(next.href)
              request(next, redirects + 1)
              return
            }
            if (response.statusCode !== 200) { reject(); return }
            const declaredHeader = response.headers['content-length']
            const declaredLength = declaredHeader === undefined ? expectedBytes : Number(declaredHeader)
            if (!Number.isSafeInteger(declaredLength) || declaredLength !== expectedBytes) { reject(); return }
            let received = 0
            const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { received += chunk.length; if (received > expectedBytes) callback(new Error('Model download failed')); else callback(null, chunk) } })
            pipeline(response, limiter, output.createWriteStream()).then(() => {
              if (received === expectedBytes) resolve()
              else reject()
            }, reject)
          }
          try {
            operation = requestGet(current, (response) => {
              if (!ready) { pendingResponse = response; return }
              handleResponse(response)
            })
          } catch {
            activeResponse = pendingResponse
            reject()
            return
          }
          activeRequest = operation
          try {
            operation.once('error', () => { if (activeRequest === operation) reject() })
            operation.setTimeout(timeout.requestMs ?? 30_000, () => { if (activeRequest === operation) reject() })
          } catch {
            activeResponse = pendingResponse
            reject()
            return
          }
          ready = true
          if (pendingResponse !== null) handleResponse(pendingResponse)
        }
        try {
          const handle = timer.set(reject, timeout.overallMs ?? 15 * 60_000)
          if (settled) {
            try { timer.clear(handle) } catch { /* cleanup is best effort */ }
          } else {
            deadline = handle
          }
        } catch {
          reject()
          return
        }
        request(parsed, 0)
      })
      succeeded = true
    } catch {
      throw new Error('Model download failed')
    } finally {
      await output.close().catch(() => undefined)
      if (!succeeded) await rm(destination, { force: true }).catch(() => undefined)
    }
  }
}

export const httpsDownloader = createHttpsDownloader()

const DOWNLOAD_HOSTS = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co', 'cas-server.xethub.hf.co'])
export function validateDownloadRedirect(current: string, location: string, redirects: number): URL {
  if (redirects >= 5) throw new Error('Model download failed')
  const origin = new URL(current)
  if (origin.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(origin.hostname) || origin.username || origin.password || origin.port) throw new Error('Model download failed')
  const next = new URL(location, current)
  if (next.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(next.hostname) || next.username || next.password || next.port) throw new Error('Model download failed')
  return next
}

export interface AtomicDirectoryOperations {
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rm: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void>
  readonly exists: (path: string) => Promise<boolean>
}

const atomicDirectoryOperations: AtomicDirectoryOperations = {
  rename,
  rm,
  exists: (path) => stat(path).then(() => true, () => false),
}

export async function replaceDirectoryAtomic(
  temporary: string,
  destination: string,
  operations: AtomicDirectoryOperations = atomicDirectoryOperations,
): Promise<void> {
  const backup = `${destination}.backup-${randomUUID()}`
  const existed = await operations.exists(destination)
  if (existed) await operations.rename(destination, backup)
  try {
    await operations.rename(temporary, destination)
  } catch {
    if (existed) {
      await operations.rename(backup, destination).catch(() => undefined)
    }
    throw new Error('Model promotion failed')
  }
  if (existed) {
    await operations.rm(backup, { recursive: true, force: true }).catch(() => undefined)
  }
}

export class ModelManager {
  private readonly catalog: CatalogLock
  private readonly bundledManifest: BundledModelManifest
  private readonly disclosureCatalog: ModelDisclosureCatalog
  private readonly operations = new Map<ModelPreset, Promise<unknown>>()
  private readonly downloading = new Set<ModelPreset>()
  private readonly completeness = new Map<ModelPreset, boolean>()
  private readonly downloader: ModelDownloader

  constructor(private readonly options: ModelManagerOptions) {
    this.catalog = deepFreeze(validateCatalog(structuredClone(options.catalog)))
    this.bundledManifest = deepFreeze(validateBundledModelManifest(
      structuredClone(options.bundledManifest),
      this.catalog,
    ))
    this.disclosureCatalog = modelDisclosureCatalogSchema.parse({
      models: PRESETS.map((preset) => {
        const model = this.catalog.presets[preset]
        const totalBytes = model.files.reduce((total, file) => total + file.bytes, 0)
        if (!Number.isSafeInteger(totalBytes)) throw new Error('Invalid model catalog')
        const sourceHost = new URL(model.files[0]!.url).hostname
        return {
          preset,
          repository: model.repository,
          sourceProvider: 'Hugging Face',
          sourceHost,
          revision: model.revision,
          totalBytes,
          license: model.license,
          bundled: model.bundled,
        }
      }),
      optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
    })
    this.downloader = options.downloader ?? httpsDownloader
  }

  disclosures(): ModelDisclosureCatalog { return this.disclosureCatalog }

  async status(preset: ModelPreset): Promise<ModelStatus> {
    const model = this.model(preset)
    if (this.downloading.has(preset)) return { preset, state: 'downloading' }
    if (model.bundled) return { preset, state: await this.isComplete(preset) ? 'bundled' : 'error' }
    return { preset, state: await this.isComplete(preset) ? 'ready' : 'missing' }
  }

  async protocolSources(): Promise<Readonly<Record<string, FileSource>>> {
    const sources: Record<string, FileSource> = {}
    for (const preset of PRESETS) {
      const model = this.catalog.presets[preset]
      if (await this.isComplete(preset)) {
        const boundaryRoot = model.bundled ? this.options.packagedRoot : this.options.userRoot
        sources[model.repository] = Object.freeze({ root: this.repositoryRoot(boundaryRoot, model.repository), boundaryRoot, files: new Set(this.filesFor(preset).map((file) => file.path)) })
      }
    }
    return Object.freeze(sources)
  }

  async install(preset: ModelPreset, input: { readonly consent: boolean }): Promise<void> {
    const model = this.model(preset)
    if (model.bundled || input.consent !== true) return Promise.reject(new Error('Model installation is not allowed'))
    return this.serial(preset, async () => {
      if (await this.isComplete(preset)) return
      const destination = this.repositoryRoot(this.options.userRoot, model.repository)
      let temporary: string | null = null
      const totalBytes = model.files.reduce((sum, file) => sum + file.bytes, 0); let completedBytes = 0
      this.downloading.add(preset); this.progress({ preset, completedBytes, totalBytes })
      try {
        const repositoryParent = await this.ensureOptionalRepositoryParent(model.repository)
        await this.assertOptionalDestinationSafe(destination, repositoryParent)
        temporary = join(repositoryParent, `.${model.repository.split('/')[1]}.partial-${randomUUID()}`)
        await mkdir(temporary)
        await this.assertManagedDirectory(this.options.userRoot, temporary)
        for (const file of model.files) {
          const destination = this.contained(temporary, file.path)
          await this.ensurePrivateDirectory(temporary, dirname(destination))
          await this.downloader(file.url, destination, file.bytes)
          if (!(await this.verify(destination, file))) throw new Error('Model verification failed')
          completedBytes += file.bytes; this.progress({ preset, completedBytes, totalBytes })
        }
        await writeFile(join(temporary, 'manifest.lock.json'), `${JSON.stringify({ version: 1, preset, repository: model.repository, revision: model.revision, files: model.files }, null, 2)}\n`, { flag: 'wx' })
        await this.assertManagedDirectory(this.options.userRoot, repositoryParent)
        await this.assertManagedDirectory(this.options.userRoot, temporary)
        await this.assertOptionalDestinationSafe(destination, repositoryParent)
        await replaceDirectoryAtomic(temporary, destination)
        temporary = null
        this.completeness.set(preset, true)
      } catch { throw new Error('Model installation failed') }
      finally {
        this.downloading.delete(preset)
        if (temporary !== null) await this.removeManagedTemporary(temporary)
      }
    })
  }

  async remove(preset: ModelPreset): Promise<void> {
    const model = this.model(preset)
    if (model.bundled) return Promise.reject(new Error('Bundled model cannot be removed'))
    return this.serial(preset, async () => {
      const destination = this.repositoryRoot(this.options.userRoot, model.repository)
      this.completeness.delete(preset)
      try {
        const repositoryParent = await this.optionalRepositoryParentIfSafe(model.repository)
        if (repositoryParent === null || !(await this.pathExists(destination))) {
          this.completeness.delete(preset)
          return
        }
        await this.assertManagedDirectory(this.options.userRoot, destination)
        await this.assertManagedDirectory(this.options.userRoot, repositoryParent)
        await rm(destination, { recursive: true, force: true })
        this.completeness.delete(preset)
      } catch {
        throw new Error('Model removal failed')
      }
    })
  }

  private model(preset: ModelPreset): LockedPreset {
    if (!PRESETS.includes(preset)) throw new Error('Unknown model preset')
    return this.catalog.presets[preset]
  }

  private async isComplete(preset: ModelPreset): Promise<boolean> {
    const cached = this.completeness.get(preset)
    if (cached !== undefined) return cached
    const model = this.catalog.presets[preset]
    const boundaryRoot = model.bundled ? this.options.packagedRoot : this.options.userRoot
    const root = this.repositoryRoot(boundaryRoot, model.repository)
    try {
      await this.assertRealContained(boundaryRoot, root)
      if (!model.bundled) {
        const manifest = await readBoundedJsonFile(join(root, 'manifest.lock.json'))
        const expected = { version: 1, preset, repository: model.repository, revision: model.revision, files: model.files }
        if (JSON.stringify(manifest) !== JSON.stringify(expected)) return false
      }
      const lockedFiles = this.filesFor(preset)
      const expectedFiles = new Set([...lockedFiles.map((file) => file.path), ...(model.bundled ? [] : ['manifest.lock.json'])])
      const actualFiles = await this.listFiles(root)
      if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) return false
      for (const file of lockedFiles) { const path = this.contained(root, file.path); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) return false; if (!(await this.verify(path, file))) return false }
      this.completeness.set(preset, true); return true
    } catch { this.completeness.delete(preset); return false }
  }

  private contained(root: string, relative: string): string { const base = resolve(root); const target = resolve(base, ...relative.split('/')); if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('Unsafe model path'); return target }
  private filesFor(preset: ModelPreset): readonly LockedFile[] { return preset === 'balanced' ? this.bundledManifest.files : this.catalog.presets[preset].files }
  private async assertRealContained(boundaryRoot: string, target: string): Promise<void> { const boundary = await realpath(boundaryRoot); const actual = await realpath(target); if (actual !== boundary && !actual.startsWith(`${boundary}${sep}`)) throw new Error('Unsafe model path') }
  private async assertManagedDirectory(boundaryRoot: string, target: string): Promise<void> {
    const [boundaryInfo, targetInfo] = await Promise.all([lstat(boundaryRoot), lstat(target)])
    if (!boundaryInfo.isDirectory() || boundaryInfo.isSymbolicLink() || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('Unsafe model path')
    await this.assertRealContained(boundaryRoot, target)
  }
  private async ensureOptionalRepositoryParent(repository: string): Promise<string> {
    const rootExists = await this.pathExists(this.options.userRoot)
    if (rootExists) {
      await this.assertManagedDirectory(this.options.userRoot, this.options.userRoot)
    } else {
      await mkdir(this.options.userRoot, { recursive: true })
      await this.assertManagedDirectory(this.options.userRoot, this.options.userRoot)
    }
    const [owner] = repository.split('/')
    const parent = this.contained(this.options.userRoot, owner!)
    if (!(await this.pathExists(parent))) await mkdir(parent)
    await this.assertManagedDirectory(this.options.userRoot, parent)
    return parent
  }
  private async optionalRepositoryParentIfSafe(repository: string): Promise<string | null> {
    if (!(await this.pathExists(this.options.userRoot))) return null
    await this.assertManagedDirectory(this.options.userRoot, this.options.userRoot)
    const [owner] = repository.split('/')
    const parent = this.contained(this.options.userRoot, owner!)
    if (!(await this.pathExists(parent))) return null
    await this.assertManagedDirectory(this.options.userRoot, parent)
    return parent
  }
  private async assertOptionalDestinationSafe(destination: string, repositoryParent: string): Promise<void> {
    await this.assertManagedDirectory(this.options.userRoot, repositoryParent)
    if (await this.pathExists(destination)) await this.assertManagedDirectory(this.options.userRoot, destination)
  }
  private async ensurePrivateDirectory(temporaryRoot: string, directory: string): Promise<void> {
    if (resolve(directory) === resolve(temporaryRoot)) return
    const relative = directory.slice(resolve(temporaryRoot).length + 1)
    let current = resolve(temporaryRoot)
    for (const part of relative.split(sep)) {
      current = join(current, part)
      if (!(await this.pathExists(current))) await mkdir(current)
      await this.assertManagedDirectory(temporaryRoot, current)
    }
  }
  private async removeManagedTemporary(temporary: string): Promise<void> {
    try {
      await this.assertManagedDirectory(this.options.userRoot, dirname(temporary))
      await this.assertManagedDirectory(this.options.userRoot, temporary)
      await rm(temporary, { recursive: true, force: true })
    } catch {
      // Never recurse into a path that is no longer provably inside the managed root.
    }
  }
  private pathExists(path: string): Promise<boolean> { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error }) }
  private repositoryRoot(root: string, repository: string): string { return this.contained(root, repository) }
  private async listFiles(root: string, directory = root): Promise<string[]> { const files: string[] = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); const info = await lstat(path); if (info.isSymbolicLink()) throw new Error('Unsafe model path'); if (info.isDirectory()) files.push(...await this.listFiles(root, path)); else if (info.isFile()) files.push(path.slice(root.length + 1).split(sep).join('/')); else throw new Error('Unsafe model path') } return files.sort() }
  private progress(value: ModelProgress): void { try { this.options.onProgress?.(Object.freeze({ ...value })) } catch { /* renderer delivery is observational */ } }
  private async verify(path: string, expected: LockedFile): Promise<boolean> { if (this.options.verifyFile) return this.options.verifyFile(path, expected); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) return false; const actual = await shaFile(path, expected.bytes); return actual.bytes === expected.bytes && actual.sha256 === expected.sha256 }
  private serial<T>(preset: ModelPreset, operation: () => Promise<T>): Promise<T> { const previous = this.operations.get(preset) ?? Promise.resolve(); const current = previous.catch(() => undefined).then(operation); this.operations.set(preset, current); void current.finally(() => { if (this.operations.get(preset) === current) this.operations.delete(preset) }).catch(() => undefined); return current }
}
