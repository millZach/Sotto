import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { get } from 'node:https'

export interface LockedFile { readonly path: string; readonly url: string; readonly bytes: number; readonly sha256: string }
export type ModelDownloader = (url: string, destination: string, expectedBytes: number) => Promise<void>

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

