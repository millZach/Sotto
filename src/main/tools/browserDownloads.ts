import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, isAbsolute } from 'node:path'
import type { BrowserDownload } from '../../shared/browser'
import { fail } from './common'

/** What Sotto needs of Electron's `DownloadItem`, so the lifecycle can be tested without Electron. */
export interface DownloadItemLike {
  getURL(): string
  getFilename(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  setSavePath(path: string): void
  pause(): void
  resume(): void
  cancel(): void
  on(event: 'updated' | 'done', listener: (event: unknown, state: string) => void): unknown
}
export interface BrowserDownloadsDependencies {
  /** Sotto's own folder where a download waits, paused, until the user answers; nobody else reads it. */
  readonly pendingFolder: string
  /** The user's Downloads folder, for Save to Downloads and Save as's starting place. */
  downloadsFolder(): string
  /** The system's Save dialog, starting at `suggested`; null when the user cancels it. */
  chooseSavePath(suggested: string): Promise<string | null>
  emit(download: BrowserDownload, gone?: boolean): void
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}
/** Where a download came from: its page's thread and working copy, the page, its host, and whether an agent's action started it. */
export interface DownloadOwner { readonly threadId: string; readonly workspaceId: string; readonly pageId: string | null; readonly host: string; readonly byAgent: boolean }
interface DownloadRecord {
  view: BrowserDownload
  readonly item: DownloadItemLike
  readonly pending: string
  chosen: string | null
  /** Chromium finished writing the pending file. */
  finished: boolean
}

/** Files that run a program or script when opened: Sotto only shows them in their folder (ADR-0222). */
const RUNS = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'inf', 'scf', 'jar', 'application', 'gadget', 'msc', 'app', 'dmg', 'pkg', 'mpkg', 'command', 'tool', 'sh', 'bash', 'zsh', 'run', 'bin', 'appimage', 'deb', 'rpm', 'desktop', 'py', 'pl', 'rb'])
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu
/** How many downloads a run keeps listed; the oldest finished one goes first. */
const KEPT = 100

/**
 * A file name a page suggested, made safe to save and to show: no folders, control or direction characters, nothing
 * Windows reserves, and at most 200 characters with its extension kept.
 */
export function safeDownloadName(suggested: string): string {
  // eslint-disable-next-line no-control-regex -- An untrusted name from a web page.
  let name = basename(suggested.replace(/\\/gu, '/')).replace(/[\x00-\x1f\x7f‪-‮⁦-⁩<>:"/\\|?*]/gu, '_').replace(/^[\s.]+|[\s.]+$/gu, '')
  if (!name || WINDOWS_RESERVED.test(name)) name = `download${name ? `-${name}` : ''}`
  if (name.length > 200) { const extension = extname(name).slice(0, 20); name = name.slice(0, 200 - extension.length) + extension }
  return name
}
/** Whether a file of this name is one Sotto opens on the user's press, rather than only showing it in its folder. */
export function opensSafely(name: string): boolean { return !RUNS.has(extname(name).slice(1).toLowerCase()) }
/** `folder/name`, or `name (1)` and so on when that is taken. */
async function freePath(folder: string, name: string): Promise<string> {
  const extension = extname(name), stem = name.slice(0, name.length - extension.length)
  for (let count = 0; count < 1000; count++) {
    const candidate = join(folder, count === 0 ? name : `${stem} (${count})${extension}`)
    if (!await stat(candidate).then(() => true, () => false)) return candidate
  }
  return join(folder, `${stem} ${randomUUID()}${extension}`)
}
async function move(from: string, to: string): Promise<void> {
  try { await rename(from, to) } catch (error) {
    if ((error as { code?: string }).code !== 'EXDEV' && (error as { code?: string }).code !== 'EPERM') throw error
    await copyFile(from, to)
    await unlink(from).catch(() => undefined)
  }
}

/**
 * The browser's downloads (ADR-0222). Nothing a page downloads is saved where the user would find it until they say
 * where: Chromium writes it, paused, into Sotto's own folder, and the pane asks. Save to Downloads or Save as moves it
 * there once it has finished; Cancel deletes it. The agent is never given where a download is.
 */
export class BrowserDownloads {
  private readonly records = new Map<string, DownloadRecord>()
  private disposed = false
  constructor(private readonly dependencies: BrowserDownloadsDependencies) {}

  /** Removes what an earlier run left waiting: a download nobody answered is not kept. */
  async sweep(): Promise<void> {
    const entries = (await readdir(this.dependencies.pendingFolder).catch(() => [] as string[])).filter(entry => !this.records.has(entry))
    await Promise.all(entries.map(entry => rm(join(this.dependencies.pendingFolder, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)))
  }
  /**
   * A page started a download. Called inside Electron's `will-download`, where the save path must be set at once:
   * it goes to a folder of its own in Sotto's pending folder and is paused there until the user answers.
   */
  start(item: DownloadItemLike, owner: DownloadOwner): BrowserDownload {
    const id = randomUUID()
    const file = safeDownloadName(item.getFilename() || 'download')
    const folder = join(this.dependencies.pendingFolder, id)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const pending = join(folder, file)
    item.setSavePath(pending)
    item.pause()
    const record: DownloadRecord = { item, pending, chosen: null, finished: false, view: {
      id, threadId: owner.threadId, workspaceId: owner.workspaceId, pageId: owner.pageId, file, host: owner.host.slice(0, 300),
      state: 'asking', receivedBytes: 0, totalBytes: Math.max(0, item.getTotalBytes() || 0), byAgent: owner.byAgent, folder: null, opens: opensSafely(file), startedAt: Date.now(),
    } }
    this.records.set(id, record)
    this.trim()
    item.on('updated', () => { this.progress(record); this.publish(record) })
    item.on('done', (_event, state) => { void this.done(record, state) })
    this.publish(record)
    return { ...record.view }
  }
  /** A thread's downloads this run, newest first. */
  list(threadId: string): BrowserDownload[] {
    return [...this.records.values()].filter(record => record.view.threadId === threadId).map(record => ({ ...record.view })).sort((a, b) => b.startedAt - a.startedAt)
  }
  /** What an agent may know of its thread's downloads: names and states, and a path only for one the user saved in the thread's folder. */
  agentView(threadId: string, workingDirectory: string): { file: string; state: BrowserDownload['state']; byAgent: boolean; path?: string }[] {
    return this.list(threadId).map(download => {
      const record = this.records.get(download.id)!
      const inside = download.state === 'saved' && record.chosen ? relative(workingDirectory, record.chosen) : null
      return { file: download.file, state: download.state, byAgent: download.byAgent, ...(inside && !inside.startsWith('..') && !isAbsolute(inside) ? { path: inside.replace(/\\/gu, '/') } : {}) }
    })
  }
  /** The user's answer to one of their thread's downloads. Answers null when it was taken off the list. */
  async act(threadId: string, id: string, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss'): Promise<BrowserDownload | null> {
    const record = this.records.get(id)
    if (!record || record.view.threadId !== threadId) return fail('blocked', 'This download is not in this thread\'s list any more.')
    if (action === 'save' || action === 'save-as') {
      if (record.view.state !== 'asking') return fail('blocked', 'This download was already answered.')
      const suggested = join(this.dependencies.downloadsFolder(), record.view.file)
      const target = action === 'save' ? await freePath(this.dependencies.downloadsFolder(), record.view.file) : await this.dependencies.chooseSavePath(suggested)
      if (!target) return { ...record.view }
      // The dialog may have taken a while: the download could have been cancelled or failed meanwhile.
      if (record.view.state !== 'asking' || this.disposed) return { ...record.view }
      record.chosen = target
      record.view.state = 'saving'
      record.view.folder = dirname(target)
      this.publish(record)
      if (record.finished) await this.place(record)
      else record.item.resume()
      return { ...record.view }
    }
    if (action === 'cancel') { this.cancel(record); return { ...record.view } }
    if (action === 'open' || action === 'show') {
      if (record.view.state !== 'saved' || !record.chosen) return fail('blocked', 'This download has not been saved.')
      if (action === 'show') { this.dependencies.showItemInFolder(record.chosen); return { ...record.view } }
      if (!record.view.opens) return fail('blocked', 'Sotto does not open programs or scripts. Use Show in folder, and open it there if you trust it.')
      const problem = await this.dependencies.openPath(record.chosen)
      if (problem) return fail('unavailable', 'This file could not be opened. Use Show in folder.')
      return { ...record.view }
    }
    this.cancel(record)
    this.records.delete(id)
    this.dependencies.emit({ ...record.view }, true)
    return null
  }
  /** Every download still asking or saving is cancelled and its pending file deleted, at once: Sotto is closing. */
  dispose(): void {
    this.disposed = true
    for (const record of this.records.values()) {
      if (record.view.state !== 'asking' && record.view.state !== 'saving') continue
      try { record.item.cancel() } catch { /* Already gone. */ }
      rmSync(dirname(record.pending), { recursive: true, force: true })
    }
    this.records.clear()
  }
  private progress(record: DownloadRecord): void {
    try {
      record.view.receivedBytes = Math.max(0, record.item.getReceivedBytes() || 0)
      record.view.totalBytes = Math.max(0, record.item.getTotalBytes() || 0)
    } catch { /* The item is gone. */ }
  }
  private cancel(record: DownloadRecord): void {
    if (record.view.state !== 'asking' && record.view.state !== 'saving') return
    record.view.state = 'cancelled'
    record.chosen = null
    if (!record.finished) { try { record.item.cancel() } catch { /* Already gone. */ } }
    void rm(dirname(record.pending), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    this.publish(record)
  }
  private async done(record: DownloadRecord, state: string): Promise<void> {
    this.progress(record)
    if (state === 'completed') {
      record.finished = true
      if (record.view.state === 'saving') await this.place(record)
      else this.publish(record)
      return
    }
    if (record.view.state === 'asking' || record.view.state === 'saving') record.view.state = state === 'cancelled' ? 'cancelled' : 'failed'
    record.chosen = null
    await rm(dirname(record.pending), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    this.publish(record)
  }
  /** Moves the finished file to where the user chose, and its waiting folder away. */
  private async place(record: DownloadRecord): Promise<void> {
    const target = record.chosen
    if (!target || this.disposed) return
    try {
      await mkdir(dirname(target), { recursive: true })
      await move(record.pending, target)
      if (record.chosen !== target) { await rm(target, { force: true }).catch(() => undefined); return }
      record.view.state = 'saved'
    } catch { record.view.state = 'failed'; record.chosen = null }
    await rm(dirname(record.pending), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    this.publish(record)
  }
  private publish(record: DownloadRecord): void {
    if (!this.disposed && this.records.get(record.view.id) === record) this.dependencies.emit({ ...record.view })
  }
  private trim(): void {
    if (this.records.size <= KEPT) return
    const oldest = [...this.records.values()].filter(record => !['asking', 'saving'].includes(record.view.state)).sort((a, b) => a.view.startedAt - b.view.startedAt)
    for (const record of oldest.slice(0, this.records.size - KEPT)) this.records.delete(record.view.id)
  }
}
