import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * A 3D model's files come from Meshy's file server and nowhere else (ADR-0141): `assets.meshy.ai` over HTTPS, under
 * the signed links a finished task names, with no key sent and no redirect followed. Each file is capped in size and
 * written only inside the folder its thread asked for, which is inside the thread's working folder, and never over a
 * file that is already there.
 */
export const MESHY_ASSETS = 'https://assets.meshy.ai'
/** The most one file may be. Meshy's models run to tens of megabytes; this leaves room and stops a runaway answer. */
export const MODEL_FILE_BYTES_MAX = 256 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** How a file is fetched: `fetch` as main and the host have it, with no redirect followed. */
export type MeshyDownloadFetch = (url: string, init: { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>>; readonly redirect: 'manual'; readonly signal: AbortSignal }) => Promise<Response>

/**
 * What went wrong, in one word. `refused`: the link is not on Meshy's file server, so nothing was fetched. `gone`:
 * Meshy no longer has the file, as after its three days. `too-large`: past the cap. `folder`: the folder is not inside
 * the thread's working folder, or the file could not be written there. `taken`: a file of that name is already there.
 * `unreachable`: no answer, or not a whole one.
 */
export type DownloadProblem = 'refused' | 'gone' | 'too-large' | 'folder' | 'taken' | 'unreachable'
export class DownloadError extends Error {
  constructor(readonly problem: DownloadProblem) { super(`meshy-download-${problem}`) }
}

/** Whether `inner` is `outer` or inside it. Both are real paths. */
export function isInside(outer: string, inner: string): boolean {
  const path = relative(outer, inner)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/**
 * The real folder a thread's 3D models go into: `folder`, relative to the thread's working folder `root`, made if it
 * is not there. Refused when it would be outside `root`, by its name or through a link.
 */
export async function modelFolder(root: string, folder: string): Promise<string> {
  if (isAbsolute(folder) || folder.includes('\0')) throw new DownloadError('folder')
  let realRoot: string
  try { realRoot = await realpath(root) } catch { throw new DownloadError('folder') }
  const target = resolve(realRoot, folder)
  if (!isInside(realRoot, target)) throw new DownloadError('folder')
  // One folder at a time, each checked before the next is made in it, so a link part way never has one made past it.
  let current = realRoot
  for (const part of relative(realRoot, target).split(sep).filter(Boolean)) {
    const next = join(current, part)
    try { await mkdir(next) } catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw new DownloadError('folder') }
    try { current = await realpath(next) } catch { throw new DownloadError('folder') }
    if (!isInside(realRoot, current)) throw new DownloadError('folder')
  }
  return current
}

/** A plain file name: no folder in it, nothing Windows refuses, and not `.` or `..`. */
const FILE_NAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\p{Cc}]{1,200}$/u

/**
 * Fetches one of Meshy's file links into `folder` as `fileName`. The folder is checked again against the thread's
 * working folder right before writing, since either may have changed since the 3D model was asked for. A file that
 * fails part way is removed.
 */
export async function downloadModelFile(fetcher: MeshyDownloadFetch, address: string, target: { readonly root: string; readonly folder: string; readonly fileName: string },
  options: { readonly assets?: string; readonly maxBytes?: number; readonly signal?: AbortSignal } = {}): Promise<void> {
  if (!isMeshyFile(address, options.assets ?? MESHY_ASSETS)) throw new DownloadError('refused')
  if (!FILE_NAME.test(target.fileName) || target.fileName !== target.fileName.trim()) throw new DownloadError('folder')
  let realRoot: string
  let realFolder: string
  try { [realRoot, realFolder] = await Promise.all([realpath(target.root), realpath(target.folder)]) } catch { throw new DownloadError('folder') }
  if (!isInside(realRoot, realFolder)) throw new DownloadError('folder')
  const maxBytes = options.maxBytes ?? MODEL_FILE_BYTES_MAX
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetcher(address, { method: 'GET', headers: {}, redirect: 'manual', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
  } catch { throw new DownloadError('unreachable') }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    // A signed link past its time answers 400 or 403; one Meshy deleted, 404 or 410.
    throw new DownloadError([400, 403, 404, 410].includes(response.status) ? 'gone' : 'unreachable')
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new DownloadError('too-large')
  }
  const path = join(realFolder, target.fileName)
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, 'wx', 0o644) } catch (error) {
    await response.body.cancel().catch(() => undefined)
    throw new DownloadError(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST' ? 'taken' : 'folder')
  }
  let written = 0
  let finished = false
  const reader = response.body.getReader()
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try { chunk = await reader.read() } catch { throw new DownloadError('unreachable') }
      if (chunk.done) break
      written += chunk.value.byteLength
      if (written > maxBytes) throw new DownloadError('too-large')
      try { await file.write(chunk.value) } catch { throw new DownloadError('folder') }
    }
    finished = true
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    await file.close().catch(() => undefined)
    if (!finished) await rm(path, { force: true }).catch(() => undefined)
  }
}

/** Whether a link is on Meshy's file server: its origin exactly, with no name or password in it. */
function isMeshyFile(address: string, assets: string): boolean {
  let url: URL
  try { url = new URL(address) } catch { return false }
  return url.origin === new URL(assets).origin && url.username === '' && url.password === ''
}
