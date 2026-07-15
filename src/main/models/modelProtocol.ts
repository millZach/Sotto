import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'

export const MODEL_SCHEME = 'talktype-model'
export const RUNTIME_SCHEME = 'talktype-runtime'

export interface SchemeRegistrar {
  registerSchemesAsPrivileged(schemes: readonly unknown[]): void
}

export interface FileSource {
  readonly root: string
  readonly boundaryRoot: string
  readonly files: ReadonlySet<string>
}

const RUNTIME_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.wasm',
] as const
const SHA256 = /^[a-f0-9]{64}$/

interface RuntimeFileRecord {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

interface RuntimeManifest {
  readonly version: 1
  readonly files: readonly RuntimeFileRecord[]
}

export class ModelPathDeniedError extends Error {
  readonly code = 'MODEL_PATH_DENIED'
  constructor() { super('Local asset request denied'); this.name = 'ModelPathDeniedError' }
}

export class ProtocolCleanupError extends Error {
  readonly code = 'PROTOCOL_CLEANUP_FAILED'
  constructor() { super('Local protocol cleanup failed'); this.name = 'ProtocolCleanupError' }
}

const denied = (): never => { throw new ModelPathDeniedError() }
function parseUrl(raw: string): URL { try { return new URL(raw) } catch { return denied() } }
function decode(raw: string): string { try { return decodeURIComponent(raw) } catch { return denied() } }

export function registerModelSchemesAsPrivileged(protocol: SchemeRegistrar): void {
  const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  protocol.registerSchemesAsPrivileged([
    { scheme: MODEL_SCHEME, privileges: { ...privileges } },
    { scheme: RUNTIME_SCHEME, privileges: { ...privileges } },
  ])
}

function parseSafeRelative(raw: string, scheme: string, host: string): string {
  if (!raw.startsWith(`${scheme}://${host}/`)) denied()
  if (/[?#%\\]/.test(raw) || [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) denied()
  const url = parseUrl(raw)
  if (url.protocol !== `${scheme}:` || url.hostname !== host || url.host !== host || url.username || url.password || url.port || url.search || url.hash) {
    denied()
  }
  let encoded = raw.slice(`${scheme}://${host}/`.length)
  for (let index = 0; index < 2; index += 1) {
    const decoded = decode(encoded)
    if (decoded !== encoded && /(?:^|[\\/])\.\.(?:[\\/]|$)|[\\:\0]/.test(decoded)) denied()
    encoded = decoded
  }
  if (!encoded || encoded.startsWith('/') || encoded.includes('\\') || encoded.split('/').some((part) => !part || part === '.' || part === '..')) denied()
  return encoded
}

async function resolveListed(relative: string, source: FileSource): Promise<string> {
  if (!source.files.has(relative)) denied()
  const boundary = resolve(source.boundaryRoot)
  const root = resolve(source.root)
  const target = resolve(root, ...relative.split('/'))
  if (root !== boundary && !root.startsWith(`${boundary}${sep}`)) denied()
  if (target !== root && !target.startsWith(`${root}${sep}`)) denied()
  let canonicalTarget = ''
  try {
    const [actualBoundary, actualRoot, actualTarget, targetInfo] = await Promise.all([
      realpath(boundary),
      realpath(root),
      realpath(target),
      lstat(target),
    ])
    if (actualRoot !== actualBoundary && !actualRoot.startsWith(`${actualBoundary}${sep}`)) denied()
    if (actualTarget !== actualRoot && !actualTarget.startsWith(`${actualRoot}${sep}`)) denied()
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) denied()
    canonicalTarget = actualTarget
  } catch (error) {
    if (error instanceof ModelPathDeniedError) throw error
    denied()
  }
  return canonicalTarget
}

async function hashFile(path: string, maximumBytes: number): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    const data = chunk as Buffer
    bytes += data.length
    if (bytes > maximumBytes) throw new Error('Invalid runtime assets')
    hash.update(data)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (typeof value !== 'object' || value === null || Object.keys(value).sort().join() !== 'files,version') return false
  const manifest = value as Partial<RuntimeManifest>
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== RUNTIME_FILES.length) return false
  return manifest.files.every((file, index) => (
    typeof file === 'object'
    && file !== null
    && Object.keys(file).sort().join() === 'bytes,path,sha256'
    && file.path === RUNTIME_FILES[index]
    && Number.isSafeInteger(file.bytes)
    && file.bytes >= 0
    && SHA256.test(file.sha256)
  ))
}

/** Loads the packaged ONNX runtime allowlist without performing any network access. */
export async function loadVerifiedRuntimeSource(root: string): Promise<FileSource> {
  const invalid = (): never => { throw new Error('Invalid runtime assets') }
  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid()
    const actualRoot = await realpath(root)
    const entries = await readdir(root, { withFileTypes: true })
    const expectedNames = new Set<string>(['manifest.lock.json', ...RUNTIME_FILES])
    if (entries.length !== expectedNames.size || entries.some((entry) => !expectedNames.has(entry.name))) invalid()

    const manifestPath = resolve(root, 'manifest.lock.json')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64_000) invalid()
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    if (!isRuntimeManifest(parsed)) throw new Error('Invalid runtime assets')

    for (const file of parsed.files) {
      const target = resolve(root, file.path)
      const [targetInfo, actualTarget] = await Promise.all([lstat(target), realpath(target)])
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size !== file.bytes) invalid()
      if (actualTarget !== actualRoot && !actualTarget.startsWith(`${actualRoot}${sep}`)) invalid()
      const integrity = await hashFile(target, file.bytes)
      if (integrity.bytes !== file.bytes || integrity.sha256 !== file.sha256) invalid()
    }

    return Object.freeze({
      root,
      boundaryRoot: root,
      files: new Set<string>(RUNTIME_FILES),
    })
  } catch {
    return invalid()
  }
}

export async function resolveModelRequest(raw: string, sources: Readonly<Record<string, FileSource>>): Promise<string> {
  const relative = parseSafeRelative(raw, MODEL_SCHEME, 'model')
  const repository = Object.keys(sources).find((candidate) => relative.startsWith(`${candidate}/`))
  if (repository === undefined) throw new ModelPathDeniedError()
  return resolveListed(relative.slice(repository.length + 1), sources[repository]!)
}

export async function resolveRuntimeRequest(raw: string, source: FileSource): Promise<string> {
  return resolveListed(parseSafeRelative(raw, RUNTIME_SCHEME, 'runtime'), source)
}

export interface ProtocolAdapter {
  handle(scheme: string, handler: (request: { readonly method: string; readonly url: string }) => Promise<Response>): void
  unhandle(scheme: string): void
}

export function registerLocalAssetProtocols(options: {
  readonly protocol: ProtocolAdapter
  readonly net: { fetch(url: string): Promise<Response> }
  readonly modelSources: () => Promise<Readonly<Record<string, FileSource>>>
  readonly runtimeSource: FileSource
}): () => void {
  const installed: string[] = []
  const handler = (resolveRequest: (url: string) => string | Promise<string>) => async (request: { readonly method: string; readonly url: string }): Promise<Response> => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    try { return await options.net.fetch(pathToFileURL(await resolveRequest(request.url)).href) }
    catch { return new Response(null, { status: 404 }) }
  }
  const modelHandler = handler(async (url) => resolveModelRequest(url, await options.modelSources()))
  try { options.protocol.handle(MODEL_SCHEME, modelHandler); installed.push(MODEL_SCHEME); options.protocol.handle(RUNTIME_SCHEME, handler((url) => resolveRuntimeRequest(url, options.runtimeSource))); installed.push(RUNTIME_SCHEME) }
  catch { for (const scheme of installed.reverse()) { try { options.protocol.unhandle(scheme) } catch { /* preserve registration failure */ } } throw new Error('Local protocol registration failed') }
  let cleaned = false
  return () => { if (cleaned) return; cleaned = true; let failed = false; for (const scheme of installed.reverse()) { try { options.protocol.unhandle(scheme) } catch { failed = true } } if (failed) throw new ProtocolCleanupError() }
}
