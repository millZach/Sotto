import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, rmSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
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
/**
 * Where a download came from: its page's thread and working copy, the page, its host, whether an agent's action started
 * it, and whether the page was shared with the agent when it started.
 */
export interface DownloadOwner { readonly threadId: string; readonly workspaceId: string; readonly pageId: string | null; readonly host: string; readonly byAgent: boolean; readonly shared?: boolean }
interface DownloadRecord {
  view: BrowserDownload
  readonly item: DownloadItemLike
  readonly pending: string
  chosen: string | null
  /** Save as: the user chose `chosen` in the Save dialog, so it may replace a file there. Save to Downloads never does. */
  replaces: boolean
  /** The path held for this download from the user's answer until it is placed, so no other download takes it. */
  reserved: string | null
  /** Chromium finished writing the pending file. */
  finished: boolean
  /**
   * The file is being placed: `place` alone then ends the download, lets go of its name and deletes its waiting folder,
   * so a Cancel meanwhile cannot hand the name to another download or delete a file it never wrote.
   */
  placing: boolean
  /** Cancel was pressed while the file was placed: it stops a file that has not started to move. */
  cancelAsked: boolean
  /** The page was shared with the agent when the download started. */
  readonly sharedAtStart: boolean
}

/** Files that run a program or script when opened: Sotto only shows them in their folder (ADR-0222). */
const RUNS = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'inf', 'scf', 'jar', 'application', 'gadget', 'msc', 'app', 'dmg', 'pkg', 'mpkg', 'command', 'tool', 'sh', 'bash', 'zsh', 'run', 'bin', 'appimage', 'deb', 'rpm', 'desktop', 'py', 'pl', 'rb',
  // Disk images mount and can run what they hold; help files, add-ins and patches run code; shortcuts, settings,
  // libraries and saved searches point somewhere else.
  'iso', 'img', 'vhd', 'vhdx', 'chm', 'xll', 'appref-ms', 'msp', 'settingcontent-ms', 'library-ms', 'search-ms'])
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
/** A path as the disk compares it: Windows' and macOS's usual disks ignore case. */
function sameOnDisk(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
}
/** Moves a file to `to` only if nothing is there: a hard link, or a copy that refuses to replace, and the original goes. */
async function moveWithoutReplacing(from: string, to: string): Promise<void> {
  try { await link(from, to) } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw error
    // Another disk, or one that takes no hard links: a copy that fails with EEXIST rather than replace a file.
    await copyFile(from, to, constants.COPYFILE_EXCL)
  }
  await unlink(from).catch(() => undefined)
}
/** Save as's move, which may replace the file the user chose in the Save dialog. */
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
  /** Paths answered for and not yet placed, as the disk compares them (`sameOnDisk`). */
  private readonly reserved = new Set<string>()
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
    const record: DownloadRecord = { item, pending, chosen: null, replaces: false, reserved: null, finished: false, placing: false, cancelAsked: false, sharedAtStart: owner.shared === true, view: {
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
  /**
   * What an agent may know of its thread's downloads: names and states, and a path only for one the user saved in the
   * thread's folder. Only a download from a page that was shared with it when the download started, and that `shared`
   * says is shared with it still, is listed, its own action's among them: a page the user keeps private, or kept
   * private then, keeps its downloads too, however lately the agent acted there. `masked` gives a name as its page says
   * anything back, with a secret typed there masked, since a site names its own file.
   */
  agentView(threadId: string, workingDirectory: string, shared: (pageId: string) => boolean, masked: (pageId: string, text: string) => string = (_pageId, text) => text): { file: string; state: BrowserDownload['state']; byAgent: boolean; path?: string }[] {
    return this.list(threadId).filter(download => this.known(download, shared)).map(download => {
      const record = this.records.get(download.id)!
      const inside = download.state === 'saved' && record.chosen ? relative(workingDirectory, record.chosen) : null
      const mask = (text: string): string => masked(download.pageId!, text)
      return { file: mask(download.file), state: download.state, byAgent: download.byAgent, ...(inside && !inside.startsWith('..') && !isAbsolute(inside) ? { path: mask(inside.replace(/\\/gu, '/')) } : {}) }
    })
  }
  /** The names of the downloads a page started since `since` that the agent may know of, for its action's answer. */
  startedSince(threadId: string, pageId: string, since: number, shared: (pageId: string) => boolean): string[] {
    return this.list(threadId).filter(download => download.pageId === pageId && download.startedAt >= since && this.known(download, shared)).map(download => download.file)
  }
  private known(download: BrowserDownload, shared: (pageId: string) => boolean): boolean {
    return this.records.get(download.id)?.sharedAtStart === true && download.pageId !== null && shared(download.pageId)
  }
  /** The user's answer to one of their thread's downloads. Answers null when it was taken off the list. */
  async act(threadId: string, id: string, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss'): Promise<BrowserDownload | null> {
    const record = this.records.get(id)
    if (!record || record.view.threadId !== threadId) return fail('blocked', 'This download is not in this thread\'s list any more.')
    if (action === 'save' || action === 'save-as') {
      if (record.view.state !== 'asking') return fail('blocked', 'This download was already answered.')
      const suggested = join(this.dependencies.downloadsFolder(), record.view.file)
      // Save to Downloads holds the free name it finds at once, so a second download of the same name finds the next.
      const target = action === 'save' ? await this.freePath(this.dependencies.downloadsFolder(), record.view.file) : await this.dependencies.chooseSavePath(suggested)
      if (!target) return { ...record.view }
      // The dialog may have taken a while: the download could have been cancelled or failed meanwhile.
      if (record.view.state !== 'asking' || this.disposed) { if (action === 'save') this.reserved.delete(sameOnDisk(target)); return { ...record.view } }
      if (action === 'save-as') {
        // The dialog's answer replaces what is there, but not a file another download is about to put there.
        if (this.reserved.has(sameOnDisk(target))) return fail('blocked', 'Another download is being saved with that name. Choose another name.')
        this.reserved.add(sameOnDisk(target))
      }
      record.chosen = target
      record.reserved = target
      record.replaces = action === 'save-as'
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
  /**
   * Every download still asking or saving is cancelled and its pending file deleted, at once: Sotto is closing. One being
   * placed is left to `place`, which places nothing more once this has run.
   */
  dispose(): void {
    this.disposed = true
    for (const record of this.records.values()) {
      if ((record.view.state !== 'asking' && record.view.state !== 'saving') || record.placing) continue
      try { record.item.cancel() } catch { /* Already gone. */ }
      rmSync(dirname(record.pending), { recursive: true, force: true })
    }
    this.records.clear()
    this.reserved.clear()
  }
  /**
   * Cancels the downloads still asking in each thread `gone` names, one that closed or was deleted: nobody is left to
   * answer them. One the user already placed goes on to where they said.
   */
  cancelThreads(gone: (threadId: string) => boolean): void {
    for (const record of [...this.records.values()]) if (record.view.state === 'asking' && gone(record.view.threadId)) this.cancel(record)
  }
  /** `folder/name`, or `name (1)` and so on when a file or another download has it; held for the caller at once. */
  private async freePath(folder: string, name: string): Promise<string> {
    const extension = extname(name), stem = name.slice(0, name.length - extension.length)
    for (let count = 0; count < 1000; count++) {
      const candidate = join(folder, count === 0 ? name : `${stem} (${count})${extension}`)
      if (this.reserved.has(sameOnDisk(candidate))) continue
      if (await stat(candidate).then(() => true, () => false)) continue
      // Checked again after the look at the disk, which another answer may have overlapped.
      if (this.reserved.has(sameOnDisk(candidate))) continue
      this.reserved.add(sameOnDisk(candidate))
      return candidate
    }
    const last = join(folder, `${stem} ${randomUUID()}${extension}`)
    this.reserved.add(sameOnDisk(last))
    return last
  }
  /** The download no longer holds a path: it is placed, failed or cancelled. */
  private release(record: DownloadRecord): void {
    if (record.reserved) this.reserved.delete(sameOnDisk(record.reserved))
    record.reserved = null
  }
  private progress(record: DownloadRecord): void {
    try {
      record.view.receivedBytes = Math.max(0, record.item.getReceivedBytes() || 0)
      record.view.totalBytes = Math.max(0, record.item.getTotalBytes() || 0)
    } catch { /* The item is gone. */ }
  }
  private cancel(record: DownloadRecord): void {
    if (record.view.state !== 'asking' && record.view.state !== 'saving') return
    // The file is on its way to where the user said: `place` stops it if it has not started to move, and says which.
    if (record.placing) { record.cancelAsked = true; return }
    record.view.state = 'cancelled'
    record.chosen = null
    this.release(record)
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
    this.release(record)
    await rm(dirname(record.pending), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    this.publish(record)
  }
  /**
   * Moves the finished file to where the user chose, and its waiting folder away. Save to Downloads never replaces a
   * file: one that appeared at its name after the user answered sends it to the next free name.
   *
   * While it runs, the download keeps its name and its waiting folder whatever else happens (`placing`). A Cancel, or
   * Sotto closing, stops a file that has not started to move; one that has is placed, since stopping it then could only
   * be done by deleting what is at the target, which may be the user's own file or another download's. Nothing here
   * deletes a file at a target.
   */
  private async place(record: DownloadRecord): Promise<void> {
    let target = record.chosen
    if (!target || this.disposed || record.placing) return
    record.placing = true
    const stopped = (): boolean => record.cancelAsked || this.disposed
    let ended: 'saved' | 'cancelled' | 'failed' = 'failed'
    try {
      await mkdir(dirname(target), { recursive: true })
      if (stopped()) ended = 'cancelled'
      else if (record.replaces) { await move(record.pending, target); ended = 'saved' }
      else for (let tries = 0; ; tries++) {
        try { await moveWithoutReplacing(record.pending, target); ended = 'saved'; break } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST' || tries >= 20) throw error
          const next = await this.freePath(dirname(target), record.view.file)
          this.release(record)
          record.reserved = record.chosen = target = next
          if (stopped()) { ended = 'cancelled'; break }
        }
      }
    } catch { /* Not placed: a file that could not move, or a disk that refused it. */ }
    record.placing = false
    // A save that failed after the user pressed Cancel saved nothing, as they asked.
    record.view.state = ended === 'failed' && record.cancelAsked ? 'cancelled' : ended
    if (ended === 'saved') {
      // The name it was saved under decides too: Save as can give a document a program's name.
      record.view.opens = opensSafely(record.view.file) && opensSafely(basename(target))
    } else record.chosen = null
    this.release(record)
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
