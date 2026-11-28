// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserDownloads, opensSafely, safeDownloadName, type DownloadItemLike } from '../../../src/main/tools/browserDownloads'
import type { BrowserDownload } from '../../../src/shared/browser'

/** The next call of one file operation on a matching path, held until the test lets it go. */
const gates = vi.hoisted(() => ({ next: null as null | { op: string; matches: (path: string) => boolean; reached: () => void; release: Promise<void> } }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const held = (op: string, call: (...args: never[]) => Promise<unknown>) => async (...args: unknown[]): Promise<unknown> => {
    const gate = gates.next
    if (gate?.op === op && gate.matches(String(args[0]))) { gates.next = null; gate.reached(); await gate.release }
    return (call as (...given: unknown[]) => Promise<unknown>)(...args)
  }
  return { ...actual, mkdir: held('mkdir', actual.mkdir), link: held('link', actual.link), rename: held('rename', actual.rename), unlink: held('unlink', actual.unlink), stat: held('stat', actual.stat) }
})
/** Holds the next `op` on a path `matches` accepts: `reached` settles once the call is waiting, and `release` lets it go on. */
function hold(op: string, matches: (path: string) => boolean): { reached: Promise<void>; release: () => void } {
  let reached!: () => void, release!: () => void
  const there = new Promise<void>(resolve => { reached = resolve })
  gates.next = { op, matches, reached, release: new Promise<void>(resolve => { release = resolve }) }
  return { reached: there, release }
}
afterEach(() => { gates.next = null })

/** Electron's DownloadItem as far as Sotto uses it: Chromium writes to the save path once resumed. */
class FakeItem extends EventEmitter implements DownloadItemLike {
  savePath = ''
  paused = false
  cancelled = false
  constructor(private readonly name: string, private readonly body = 'file body', private readonly url = 'https://files.example/report.pdf') { super() }
  getURL(): string { return this.url }
  getFilename(): string { return this.name }
  getTotalBytes(): number { return this.body.length }
  getReceivedBytes(): number { return this.paused ? 0 : this.body.length }
  setSavePath(path: string): void { this.savePath = path }
  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  cancel(): void { this.cancelled = true; this.emit('done', {}, 'cancelled') }
  /** Chromium finishes writing the file. */
  async finish(): Promise<void> {
    await writeFile(this.savePath, this.body)
    this.emit('done', {}, 'completed')
  }
  override on(event: 'updated' | 'done', listener: (event: unknown, state: string) => void): this { return super.on(event, listener) }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function fixture(chosen: (suggested: string) => string | null = () => null) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-downloads-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const pendingFolder = join(root, 'pending'), downloadsFolder = join(root, 'Downloads'), thread = join(root, 'thread')
  await mkdir(downloadsFolder); await mkdir(thread)
  const emitted: { download: BrowserDownload; gone?: boolean }[] = []
  const openPath = vi.fn(async () => ''), showItemInFolder = vi.fn(), chooseSavePath = vi.fn(async (suggested: string) => chosen(suggested))
  const downloads = new BrowserDownloads({ pendingFolder, downloadsFolder: () => downloadsFolder, chooseSavePath, openPath, showItemInFolder, emit: (download, gone) => emitted.push({ download, ...gone ? { gone } : {} }) })
  cleanup.push(async () => downloads.dispose())
  const owner = { threadId: 'thread-a', workspaceId: 'w'.repeat(64), pageId: 'page-1', host: 'files.example', byAgent: false }
  return { root, pendingFolder, downloadsFolder, thread, downloads, emitted, openPath, showItemInFolder, chooseSavePath, owner }
}
const settle = async (check: () => void | Promise<void>): Promise<void> => vi.waitFor(check, { timeout: 2000 })

describe('a page\'s download asks where to save it (ADR-0222)', () => {
  it('holds the download paused in Sotto\'s own folder, and puts nothing in Downloads until the user answers', async () => {
    const { downloads, pendingFolder, downloadsFolder, owner, emitted } = await fixture()
    const item = new FakeItem('report.pdf')
    const started = downloads.start(item, owner)
    expect(started).toMatchObject({ file: 'report.pdf', state: 'asking', host: 'files.example', byAgent: false, folder: null, opens: true })
    expect(item.paused).toBe(true)
    expect(item.savePath.startsWith(pendingFolder)).toBe(true)
    await item.finish()
    await settle(() => expect(emitted.at(-1)?.download.state).toBe('asking'))
    expect(await readdir(downloadsFolder)).toEqual([])
  })

  it('saves to Downloads on Save, after Chromium finishes, without overwriting a file there', async () => {
    const { downloads, downloadsFolder, owner, pendingFolder } = await fixture()
    await writeFile(join(downloadsFolder, 'report.pdf'), 'older')
    const item = new FakeItem('report.pdf', 'newer')
    const { id } = downloads.start(item, owner)
    const saving = await downloads.act(owner.threadId, id, 'save')
    expect(saving).toMatchObject({ state: 'saving', folder: downloadsFolder })
    expect(item.paused).toBe(false)
    await item.finish()
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('saved'))
    expect(await readFile(join(downloadsFolder, 'report.pdf'), 'utf8')).toBe('older')
    expect(await readFile(join(downloadsFolder, 'report (1).pdf'), 'utf8')).toBe('newer')
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })

  it('moves a download that finished while asking as soon as the user saves it', async () => {
    const { downloads, downloadsFolder, owner } = await fixture()
    const item = new FakeItem('notes.txt', 'notes')
    const { id } = downloads.start(item, owner)
    await item.finish()
    expect(await downloads.act(owner.threadId, id, 'save')).toMatchObject({ state: 'saved' })
    expect(await readFile(join(downloadsFolder, 'notes.txt'), 'utf8')).toBe('notes')
  })

  it('saves where the Save dialog says, and keeps asking when the dialog is cancelled', async () => {
    let answer: string | null = null
    const { downloads, root, owner, chooseSavePath, downloadsFolder } = await fixture(() => answer)
    const item = new FakeItem('report.pdf')
    const { id } = downloads.start(item, owner)
    expect(await downloads.act(owner.threadId, id, 'save-as')).toMatchObject({ state: 'asking' })
    expect(chooseSavePath).toHaveBeenCalledWith(join(downloadsFolder, 'report.pdf'))
    answer = join(root, 'chosen', 'final.pdf')
    expect(await downloads.act(owner.threadId, id, 'save-as')).toMatchObject({ state: 'saving', folder: join(root, 'chosen') })
    await item.finish()
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('saved'))
    expect(await readFile(answer, 'utf8')).toBe('file body')
  })

  it('cancels and deletes on Cancel, and refuses a second answer', async () => {
    const { downloads, owner, pendingFolder } = await fixture()
    const item = new FakeItem('report.pdf')
    const { id } = downloads.start(item, owner)
    expect(await downloads.act(owner.threadId, id, 'cancel')).toMatchObject({ state: 'cancelled' })
    expect(item.cancelled).toBe(true)
    await expect(downloads.act(owner.threadId, id, 'save')).rejects.toMatchObject({ code: 'blocked' })
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })

  it('opens a saved document and shows any saved file in its folder, but never opens a program', async () => {
    const { downloads, owner, openPath, showItemInFolder, downloadsFolder } = await fixture()
    const document = new FakeItem('report.pdf'), program = new FakeItem('setup.EXE')
    const first = downloads.start(document, owner), second = downloads.start(program, owner)
    expect(second.opens).toBe(false)
    await expect(downloads.act(owner.threadId, first.id, 'open')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('not been saved') })
    for (const [item, id] of [[document, first.id], [program, second.id]] as const) { await item.finish(); await downloads.act(owner.threadId, id, 'save') }
    await downloads.act(owner.threadId, first.id, 'open')
    expect(openPath).toHaveBeenCalledWith(join(downloadsFolder, 'report.pdf'))
    await expect(downloads.act(owner.threadId, second.id, 'open')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('does not open programs') })
    expect(openPath).toHaveBeenCalledOnce()
    await downloads.act(owner.threadId, second.id, 'show')
    expect(showItemInFolder).toHaveBeenCalledWith(join(downloadsFolder, 'setup.EXE'))
  })

  it('keeps each thread to its own downloads', async () => {
    const { downloads, owner } = await fixture()
    const { id } = downloads.start(new FakeItem('a.txt'), owner)
    expect(downloads.list('thread-b')).toEqual([])
    await expect(downloads.act('thread-b', id, 'save')).rejects.toMatchObject({ code: 'blocked' })
  })

  it('takes a download off the list on Remove, cancelling one still asking', async () => {
    const { downloads, owner, emitted } = await fixture()
    const item = new FakeItem('a.txt')
    const { id } = downloads.start(item, owner)
    expect(await downloads.act(owner.threadId, id, 'dismiss')).toBeNull()
    expect(item.cancelled).toBe(true)
    expect(emitted.at(-1)).toMatchObject({ gone: true, download: { id } })
    expect(downloads.list(owner.threadId)).toEqual([])
  })

  it('marks a failed download and deletes what it left', async () => {
    const { downloads, owner, pendingFolder } = await fixture()
    const item = new FakeItem('a.txt')
    downloads.start(item, owner)
    item.emit('done', {}, 'interrupted')
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('failed'))
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })
})

describe('what an agent knows of a download (ADR-0222)', () => {
  it('names its thread\'s downloads and gives a path only for one the user saved in the thread\'s folder', async () => {
    let answer: string | null = null
    const { downloads, owner, thread, root } = await fixture(() => answer)
    const inside = new FakeItem('data.csv'), outside = new FakeItem('private.pdf'), asking = new FakeItem('later.zip')
    const first = downloads.start(inside, { ...owner, byAgent: true }), second = downloads.start(outside, { ...owner, shared: true })
    downloads.start(asking, { ...owner, byAgent: true })
    answer = join(thread, 'inputs', 'data.csv')
    await inside.finish(); await downloads.act(owner.threadId, first.id, 'save-as')
    answer = join(root, 'elsewhere', 'private.pdf')
    await outside.finish(); await downloads.act(owner.threadId, second.id, 'save-as')
    const view = downloads.agentView(owner.threadId, thread, () => true)
    expect(view).toContainEqual({ file: 'data.csv', state: 'saved', byAgent: true, path: 'inputs/data.csv' })
    expect(view).toContainEqual({ file: 'private.pdf', state: 'saved', byAgent: false })
    expect(view).toContainEqual({ file: 'later.zip', state: 'asking', byAgent: true })
    expect(JSON.stringify(view)).not.toContain(root.replace(/\\/gu, '\\\\'))
    expect(downloads.agentView('thread-b', thread, () => true)).toEqual([])
  })
})

describe('what the owner\'s review of downloads found (ADR-0222, November 27 amendment)', () => {
  it('gives two downloads of one name, saved to Downloads before either finishes, a name each', async () => {
    const { downloads, downloadsFolder, owner } = await fixture()
    const first = new FakeItem('notes.txt', 'one'), second = new FakeItem('notes.txt', 'two')
    const a = downloads.start(first, owner), b = downloads.start(second, owner)
    // Both are answered before either has a file in Downloads, so a look at the folder alone finds the name free twice.
    await Promise.all([downloads.act(owner.threadId, a.id, 'save'), downloads.act(owner.threadId, b.id, 'save')])
    await Promise.all([first.finish(), second.finish()])
    await settle(() => expect(downloads.list(owner.threadId).map(download => download.state)).toEqual(['saved', 'saved']))
    const names = (await readdir(downloadsFolder)).sort()
    expect(names).toEqual(['notes (1).txt', 'notes.txt'])
    expect((await Promise.all(names.map(name => readFile(join(downloadsFolder, name), 'utf8')))).sort()).toEqual(['one', 'two'])
  })

  it('never replaces a file that appears in Downloads after Save, and takes the next free name', async () => {
    const { downloads, downloadsFolder, owner, showItemInFolder } = await fixture()
    const item = new FakeItem('report.pdf', 'download')
    const { id } = downloads.start(item, owner)
    await downloads.act(owner.threadId, id, 'save')
    await writeFile(join(downloadsFolder, 'report.pdf'), 'the user\'s own')
    await item.finish()
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('saved'))
    expect(await readFile(join(downloadsFolder, 'report.pdf'), 'utf8')).toBe('the user\'s own')
    expect(await readFile(join(downloadsFolder, 'report (1).pdf'), 'utf8')).toBe('download')
    // Show in folder goes to the file Sotto wrote, not the one it found there.
    await downloads.act(owner.threadId, id, 'show')
    expect(showItemInFolder).toHaveBeenCalledWith(join(downloadsFolder, 'report (1).pdf'))
  })

  it('takes a name that differs only in case as taken where the disk ignores case', async () => {
    const { downloads, downloadsFolder, owner } = await fixture()
    const upper = new FakeItem('Notes.txt', 'upper'), lower = new FakeItem('notes.txt', 'lower')
    const a = downloads.start(upper, owner), b = downloads.start(lower, owner)
    await downloads.act(owner.threadId, a.id, 'save'); await downloads.act(owner.threadId, b.id, 'save')
    await upper.finish(); await lower.finish()
    await settle(() => expect(downloads.list(owner.threadId).map(download => download.state)).toEqual(['saved', 'saved']))
    const names = await readdir(downloadsFolder)
    expect(names).toHaveLength(2)
    expect((await Promise.all(names.map(name => readFile(join(downloadsFolder, name), 'utf8')))).sort()).toEqual(['lower', 'upper'])
  })

  it('lets Save as replace the file the user chose in the Save dialog', async () => {
    let chosen = ''
    const { downloads, root, owner } = await fixture(() => chosen)
    chosen = join(root, 'chosen.pdf')
    await writeFile(chosen, 'older')
    const item = new FakeItem('report.pdf', 'newer')
    const { id } = downloads.start(item, owner)
    await downloads.act(owner.threadId, id, 'save-as')
    await item.finish()
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('saved'))
    expect(await readFile(chosen, 'utf8')).toBe('newer')
  })

  it('does not open a file saved under a name that runs a program', async () => {
    let chosen = ''
    const { downloads, root, owner, openPath } = await fixture(() => chosen)
    chosen = join(root, 'notes.exe')
    const item = new FakeItem('notes.txt')
    const { id } = downloads.start(item, owner)
    await downloads.act(owner.threadId, id, 'save-as')
    await item.finish()
    await settle(() => expect(downloads.list(owner.threadId)[0]).toMatchObject({ state: 'saved', opens: false }))
    await expect(downloads.act(owner.threadId, id, 'open')).rejects.toMatchObject({ code: 'blocked' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('tells the agent only of downloads it started or that came from a page shared with it then and now', async () => {
    const { downloads, owner, thread } = await fixture()
    downloads.start(new FakeItem('by-agent.zip'), { ...owner, pageId: 'private-page', byAgent: true })
    downloads.start(new FakeItem('shared.pdf'), { ...owner, pageId: 'shared-page', shared: true })
    // Started while its page was private, and the page shared since: still the user's.
    downloads.start(new FakeItem('before-sharing.pdf'), { ...owner, pageId: 'shared-page' })
    downloads.start(new FakeItem('private.pdf'), { ...owner, pageId: 'private-page', shared: true })
    downloads.start(new FakeItem('no-page.pdf'), { ...owner, pageId: null, shared: true })
    const view = downloads.agentView(owner.threadId, thread, pageId => pageId === 'shared-page')
    expect(view.map(download => download.file).sort()).toEqual(['by-agent.zip', 'shared.pdf'])
  })

  it('cancels the downloads still asking in a thread that has closed or gone, and keeps the rest', async () => {
    const { downloads, owner, pendingFolder } = await fixture()
    const gone = new FakeItem('gone.zip'), kept = new FakeItem('kept.zip'), saving = new FakeItem('saving.zip')
    const a = downloads.start(gone, { ...owner, threadId: 'thread-gone' })
    downloads.start(kept, owner)
    const c = downloads.start(saving, { ...owner, threadId: 'thread-gone' })
    await downloads.act('thread-gone', c.id, 'save')
    downloads.cancelThreads(threadId => threadId === 'thread-gone')
    expect(gone.cancelled).toBe(true)
    expect(kept.cancelled).toBe(false)
    // One the user already placed goes on to where they said.
    expect(saving.cancelled).toBe(false)
    expect(downloads.list('thread-gone').find(download => download.id === a.id)?.state).toBe('cancelled')
    await settle(async () => expect(await readdir(pendingFolder)).not.toContain(a.id))
  })
})

describe('a Cancel that comes while a download is placed (the second review of ADR-0222\'s November 27 amendment)', () => {
  it('neither replaces nor deletes the file Save as chose when Cancel comes before the file moves', async () => {
    let chosen = ''
    const { downloads, root, owner, pendingFolder } = await fixture(() => chosen)
    chosen = join(root, 'existing.pdf')
    await writeFile(chosen, 'the user\'s own')
    const item = new FakeItem('report.pdf', 'download')
    const { id } = downloads.start(item, owner)
    await item.finish()
    const folder = hold('mkdir', path => path === root)
    const saving = downloads.act(owner.threadId, id, 'save-as')
    await folder.reached
    await downloads.act(owner.threadId, id, 'cancel')
    folder.release()
    await saving
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('cancelled'))
    expect(await readFile(chosen, 'utf8')).toBe('the user\'s own')
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })

  it('places a Save as whose file had started to move when Cancel came, and deletes nothing', async () => {
    let chosen = ''
    const { downloads, root, owner, pendingFolder } = await fixture(() => chosen)
    chosen = join(root, 'existing.pdf')
    await writeFile(chosen, 'older')
    const item = new FakeItem('report.pdf', 'newer')
    const { id } = downloads.start(item, owner)
    await item.finish()
    const moving = hold('rename', path => path === item.savePath)
    const saving = downloads.act(owner.threadId, id, 'save-as')
    await moving.reached
    await downloads.act(owner.threadId, id, 'cancel')
    moving.release()
    await saving
    // The user chose to replace it in the Save dialog; Cancel came too late to stop that, and takes nothing more away.
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).not.toBe('saving'))
    expect(await readFile(chosen, 'utf8')).toBe('newer')
    expect(downloads.list(owner.threadId)[0]?.state).toBe('saved')
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })

  it('holds a name until its download is placed, so a Cancel meanwhile neither frees it nor deletes another download\'s file', async () => {
    let chosen = ''
    const { downloads, downloadsFolder, owner } = await fixture(() => chosen)
    const first = new FakeItem('notes.txt', 'one'), second = new FakeItem('other.txt', 'two')
    const a = downloads.start(first, owner), b = downloads.start(second, owner)
    await first.finish(); await second.finish()
    const target = join(downloadsFolder, 'notes.txt')
    // The hard link is made; Cancel comes while the waiting copy is let go.
    const letGo = hold('unlink', path => path === first.savePath)
    const placing = downloads.act(owner.threadId, a.id, 'save')
    await letGo.reached
    await downloads.act(owner.threadId, a.id, 'cancel')
    chosen = target
    const other = await downloads.act(owner.threadId, b.id, 'save-as').then(view => view, (error: unknown) => error)
    letGo.release()
    await placing
    await settle(() => expect(downloads.list(owner.threadId).some(download => download.state === 'saving')).toBe(false))
    const state = (id: string) => downloads.list(owner.threadId).find(download => download.id === id)?.state
    // A download that says it is saved has its own file there, whichever answer won.
    const there = await readFile(target, 'utf8').catch(() => null)
    if (state(b.id) === 'saved') expect(there).toBe('two')
    expect(state(a.id)).toBe('saved')
    expect(there).toBe('one')
    expect(other).toMatchObject({ code: 'blocked', message: expect.stringContaining('Another download') })
    expect(state(b.id)).toBe('asking')
  })

  it('cancels a Save to Downloads that Cancel reaches while it looks for the next free name, and leaves the user\'s file', async () => {
    const { downloads, downloadsFolder, owner, pendingFolder } = await fixture()
    const item = new FakeItem('report.pdf', 'download')
    const { id } = downloads.start(item, owner)
    await downloads.act(owner.threadId, id, 'save')
    await writeFile(join(downloadsFolder, 'report.pdf'), 'the user\'s own')
    const looking = hold('stat', path => path.endsWith('report (1).pdf'))
    await item.finish()
    await looking.reached
    await downloads.act(owner.threadId, id, 'cancel')
    looking.release()
    await settle(() => expect(downloads.list(owner.threadId)[0]?.state).toBe('cancelled'))
    expect((await readdir(downloadsFolder)).sort()).toEqual(['report.pdf'])
    expect(await readFile(join(downloadsFolder, 'report.pdf'), 'utf8')).toBe('the user\'s own')
    await settle(async () => expect(await readdir(pendingFolder)).toEqual([]))
  })

  it('places nothing once Sotto closes while a download is about to be placed', async () => {
    let chosen = ''
    const { downloads, root, owner } = await fixture(() => chosen)
    chosen = join(root, 'chosen', 'report.pdf')
    const item = new FakeItem('report.pdf', 'download')
    const { id } = downloads.start(item, owner)
    await item.finish()
    const folder = hold('mkdir', path => path === join(root, 'chosen'))
    const saving = downloads.act(owner.threadId, id, 'save-as')
    await folder.reached
    downloads.dispose()
    folder.release()
    await saving
    await expect(readFile(chosen, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('downloads left behind (ADR-0222)', () => {
  it('sweeps what an earlier run left waiting, and keeps this run\'s', async () => {
    const { downloads, owner, pendingFolder } = await fixture()
    await mkdir(join(pendingFolder, 'stale-run'), { recursive: true })
    await writeFile(join(pendingFolder, 'stale-run', 'old.bin'), 'old')
    const { id } = downloads.start(new FakeItem('new.txt'), owner)
    await downloads.sweep()
    expect(await readdir(pendingFolder)).toEqual([id])
  })

  it('cancels and deletes every waiting download when Sotto closes', async () => {
    const { downloads, owner, pendingFolder } = await fixture()
    const item = new FakeItem('a.txt')
    downloads.start(item, owner)
    downloads.dispose()
    expect(item.cancelled).toBe(true)
    expect(await readdir(pendingFolder)).toEqual([])
  })
})

describe('a download\'s name (ADR-0222)', () => {
  it('keeps the name a page suggests only as a plain file name', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('passwd')
    expect(safeDownloadName('..\\..\\Windows\\win.ini')).toBe('win.ini')
    expect(safeDownloadName('re‮port.exe')).toBe('re_port.exe')
    expect(safeDownloadName('CON.txt')).toBe('download-CON.txt')
    expect(safeDownloadName('   ')).toBe('download')
    expect(safeDownloadName(`${'a'.repeat(300)}.pdf`)).toHaveLength(200)
    expect(safeDownloadName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf')).toBe(true)
  })

  it('opens documents and pictures, never programs or scripts', () => {
    for (const name of ['report.pdf', 'photo.JPG', 'notes.txt', 'data.csv']) expect(opensSafely(name)).toBe(true)
    for (const name of ['setup.exe', 'install.MSI', 'run.bat', 'script.ps1', 'link.lnk', 'tool.sh', 'app.dmg', 'page.hta']) expect(opensSafely(name)).toBe(false)
    // A disk image mounts and can run what it holds, a help file or an add-in runs code, and a shortcut, settings, library
    // or search file points somewhere else (the review's list).
    for (const name of ['disk.iso', 'disk.img', 'disk.vhd', 'disk.VHDX', 'help.chm', 'addin.xll', 'app.appref-ms', 'patch.msp', 'x.settingcontent-ms', 'x.library-ms', 'x.search-ms']) expect(opensSafely(name)).toBe(false)
  })
})
