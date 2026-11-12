// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { FileDownloads } from '../../../src/main/files/downloads'
import { registerFilesIpc, type HostedThreadFiles } from '../../../src/main/files/ipc'
import { FilesService } from '../../../src/main/files/service'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, FILES_REVEAL_LINK, FILES_PREVIEW_LINK, FILES_OPEN_LINK, FILES_LINKED_FILE, FILES_DOWNLOAD, FILES_DOWNLOAD_STOP, FILES_DOWNLOAD_SHOW, FILES_DOWNLOAD_OPEN } from '../../../src/shared/files'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import { ipcRegistry } from '../../fixtures/ipcHarness'

function fixture(hosted?: HostedThreadFiles, revealLinks = true, previewLinks = true) {
  const registry = ipcRegistry()
  const { ipc, handlers } = registry
  const { main, widget } = registry
  const resolveBinding = vi.fn().mockReturnValue(null), copyPath = vi.fn(), reveal = vi.fn(), open = vi.fn(async () => undefined)
  const files = new FilesService({ resolveBinding, copyPath, reveal, open })
  const part = vi.fn(async (request: { offset: number }) => ({ ok: true as const, value: { is: 'part' as const, name: 'report.pdf', size: 3, offset: request.offset, data: 'MTIz', revision: 'a'.repeat(64) } }))
  const downloads = new FileDownloads({ part, folder: () => { throw new Error('This test writes nothing.') }, progress: () => undefined })
  const dispose = registerFilesIpc(ipc, files, () => [main, widget], hosted, revealLinks, previewLinks, { downloads, reveal })
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const invoke = async (channel: string, source = event, ...args: unknown[]) => registry.invoke(channel, args, source)
  return { handlers, main, widget, event, invoke, dispose, resolveBinding, copyPath, reveal, open, part }
}
const channels = [FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL]
describe('Files IPC for opening, finding and downloading a linked file (ADR-0120, November 12 amendment)', () => {
  const onHost = { threadId: 'host:22222222-2222-4222-8222-222222222222:thread', path: '/home/me/out/report.pdf' }
  const every = [FILES_OPEN_LINK, FILES_LINKED_FILE, FILES_DOWNLOAD, FILES_DOWNLOAD_STOP, FILES_DOWNLOAD_SHOW, FILES_DOWNLOAD_OPEN]

  it('refuses all of it while the reveal-linked-files Owl answer is off, and answers only the main window', async () => {
    const linkedFile = vi.fn()
    const off = fixture({ list: vi.fn(), preview: vi.fn(), copyPath: vi.fn(), linkedFile } as unknown as HostedThreadFiles, false)
    for (const channel of every) {
      await expect(off.invoke(channel, off.event, { ...onHost, want: 'place', downloadId: '0'.repeat(32) })).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'Showing linked files is not part of this version of Sotto. Nothing was opened.' } })
      await expect(off.invoke(channel, { sender: off.widget.webContents, senderFrame: off.widget.webContents.mainFrame }, onHost)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    }
    expect(linkedFile).not.toHaveBeenCalled(); expect(off.part).not.toHaveBeenCalled(); expect(off.open).not.toHaveBeenCalled(); expect(off.reveal).not.toHaveBeenCalled()
    off.dispose()
    expect([...off.handlers.keys()].filter(channel => every.includes(channel))).toEqual([])
  })

  it('opens nothing that is on a paired host, and says so', async () => {
    const f = fixture()
    await expect(f.invoke(FILES_OPEN_LINK, f.event, onHost)).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'This file is on the host machine, so it cannot be opened here. Nothing was opened.' } })
    expect(f.resolveBinding).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
    // On this computer the service answers: here, that it has no such thread.
    await expect(f.invoke(FILES_OPEN_LINK, f.event, { threadId: 'thread', path: '/home/me/a.pdf' })).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    await expect(f.invoke(FILES_OPEN_LINK, f.event, { threadId: 'thread', path: '//evil.example/share/a.pdf' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('asks a file\'s host where it is and for its preview, and never hands the window its bytes', async () => {
    const place = { ok: true as const, value: { is: 'place' as const, name: 'report.pdf', kind: 'file' as const, size: 3, inside: null } }
    const linkedFile = vi.fn(async () => place)
    const f = fixture({ list: vi.fn(), preview: vi.fn(), copyPath: vi.fn(), linkedFile } as unknown as HostedThreadFiles)
    await expect(f.invoke(FILES_LINKED_FILE, f.event, { ...onHost, want: 'place' })).resolves.toBe(place)
    expect(linkedFile).toHaveBeenCalledWith({ ...onHost, want: 'place' })
    // The window may not ask for a part, and a host that answers one where a place was asked is not believed.
    await expect(f.invoke(FILES_LINKED_FILE, f.event, { ...onHost, want: 'part', offset: 0 })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(linkedFile).toHaveBeenCalledOnce()
    linkedFile.mockResolvedValueOnce({ ok: true, value: { is: 'part', name: 'report.pdf', size: 3, offset: 0, data: 'MTIz', revision: 'a'.repeat(64) } } as never)
    await expect(f.invoke(FILES_LINKED_FILE, f.event, { ...onHost, want: 'place' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    // With no host router behind it, a host's file cannot be reached at all.
    const bare = fixture()
    await expect(bare.invoke(FILES_LINKED_FILE, bare.event, { ...onHost, want: 'place' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('downloads only from a paired host, and shows or opens only a download it saved', async () => {
    const f = fixture()
    await expect(f.invoke(FILES_DOWNLOAD, f.event, { threadId: 'thread', path: 'out/report.pdf' })).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'This file is already on this computer. Nothing was saved.' } })
    await expect(f.invoke(FILES_DOWNLOAD, f.event, { ...onHost, path: 'C:a.pdf' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(f.part).not.toHaveBeenCalled()
    // A host's file is asked for; this fixture's Downloads folder refuses, so nothing is written and main says so.
    await expect(f.invoke(FILES_DOWNLOAD, f.event, onHost)).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'Sotto could not write to the Downloads folder. Nothing was saved.' } })
    expect(f.part).toHaveBeenCalledWith({ ...onHost, want: 'part', offset: 0 })
    await expect(f.invoke(FILES_DOWNLOAD_STOP, f.event, onHost)).resolves.toEqual({ ok: true, value: { stopped: false } })
    // The window names a saved file by main's handle and never by a path.
    for (const channel of [FILES_DOWNLOAD_SHOW, FILES_DOWNLOAD_OPEN]) {
      await expect(f.invoke(channel, f.event, { downloadId: '0'.repeat(32) })).resolves.toMatchObject({ ok: false, error: { code: 'path-unavailable', message: 'Sotto no longer knows where this download is. Look in the Downloads folder.' } })
      await expect(f.invoke(channel, f.event, { path: '/etc/passwd' })).resolves.toMatchObject({ ok: false, error: { code: 'path-unavailable' } })
    }
    expect(f.reveal).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })
})

describe('Files IPC message file links', () => {
  it('reads a linked Markdown file on the machine its thread runs on, and refuses while the Owl answer is off', async () => {
    const answer = { ok: true as const, value: { name: 'plan.md', size: 1, text: 'a' } }
    const onHost = { threadId: 'host:22222222-2222-4222-8222-222222222222:thread', path: '/home/me/plan.md' }
    const previewLink = vi.fn(async () => answer)
    const hosted = { list: vi.fn(), preview: vi.fn(), copyPath: vi.fn(), previewLink } as unknown as HostedThreadFiles
    const on = fixture(hosted)
    await expect(on.invoke(FILES_PREVIEW_LINK, on.event, onHost)).resolves.toBe(answer)
    expect(previewLink).toHaveBeenCalledWith(onHost)
    await expect(on.invoke(FILES_PREVIEW_LINK, on.event, { ...onHost, path: '//evil.example/share/a.md' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(previewLink).toHaveBeenCalledOnce()
    await expect(on.invoke(FILES_PREVIEW_LINK, { sender: on.widget.webContents, senderFrame: on.widget.webContents.mainFrame }, onHost)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    on.dispose()
    const off = fixture(hosted, true, false)
    await expect(off.invoke(FILES_PREVIEW_LINK, off.event, onHost)).resolves.toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Opening Markdown files in the side panel is not part of this version of Sotto. Nothing was opened.' } })
    expect(previewLink).toHaveBeenCalledOnce()
    off.dispose()
  })
  it('answers only the main window', async () => {
    const f = fixture()
    const link = { threadId: 'thread', path: '/missing/file.pdf' }
    await expect(f.invoke(FILES_REVEAL_LINK, { sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame }, link)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    await expect(f.invoke(FILES_REVEAL_LINK, f.event, link)).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(f.reveal).not.toHaveBeenCalled()
  })

  it('refuses every link while the Owl feature is off, as on stable', async () => {
    const f = fixture(undefined, false)
    f.resolveBinding.mockReturnValue({ threadId: 'thread', projectId: 'project', workingDirectory: process.cwd() })
    await expect(f.invoke(FILES_REVEAL_LINK, f.event, { threadId: 'thread', path: 'package.json' })).resolves.toEqual({ ok: false,
      error: { code: 'unavailable', message: 'Showing linked files is not part of this version of Sotto. Nothing was opened.' } })
    expect(f.reveal).not.toHaveBeenCalled()
  })
})
const request = { threadId: 'thread', path: '', workspaceId: 'a'.repeat(64) }
describe('Files IPC security', () => {
  it('allows the trusted main frame and returns recoverable unknown-thread errors for all methods', async () => {
    const f = fixture()
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(f.resolveBinding).toHaveBeenCalledTimes(4)
    expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
    f.dispose(); expect(f.handlers.size).toBe(0)
  })
  it('rejects widget, foreign, iframe, spoofed frame, missing, navigated and destroyed senders before binding or IO', async () => {
    const f = fixture()
    const rejected: IpcInvocationEvent[] = [
      { sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame },
      { ...f.event, sender: { ...f.main.webContents } },
      { ...f.event, senderFrame: { parent: {}, url: f.main.url } },
      { ...f.event, senderFrame: { parent: null, url: f.main.url } },
      { ...f.event, senderFrame: null },
    ]
    for (const channel of channels) for (const event of rejected) await expect(f.invoke(channel, event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    f.main.webContents.getURL = () => 'https://untrusted.example/'
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    f.main.webContents.getURL = () => f.main.url; f.main.webContents.isDestroyed = () => true
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    expect(f.resolveBinding).not.toHaveBeenCalled(); expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
  })
  it('rejects extra arguments and arbitrary roots/absolute paths before binding or IO', async () => {
    const f = fixture()
    for (const channel of channels) {
      await expect(f.invoke(channel, f.event, request, 'extra')).rejects.toThrow()
      for (const payload of [null, { ...request, root: 'C:/' }, { ...request, path: 'C:/secret' }, { ...request, path: '../secret' }, { ...request, command: 'open' }]) {
        await expect(f.invoke(channel, f.event, payload)).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
      }
    }
    expect(f.resolveBinding).not.toHaveBeenCalled(); expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
  })
  it('sends a thread on a paired host to that host, checked the same way, and refuses Show in folder in words (ADR-0025, October 5 amendment)', async () => {
    const answer = { ok: false as const, error: { code: 'unavailable' as const, message: 'From the host.' } }
    const hosted = { list: vi.fn(async () => answer), preview: vi.fn(async () => answer), copyPath: vi.fn(async () => answer) }
    const f = fixture(hosted)
    const onHost = { ...request, threadId: 'host:22222222-2222-4222-8222-222222222222:thread' }
    for (const channel of [FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH]) await expect(f.invoke(channel, f.event, onHost)).resolves.toBe(answer)
    expect(hosted.list).toHaveBeenCalledWith(onHost); expect(hosted.preview).toHaveBeenCalledWith(onHost); expect(hosted.copyPath).toHaveBeenCalledWith(onHost)
    await expect(f.invoke(FILES_REVEAL, f.event, onHost)).resolves.toEqual({ ok: false, error: { code: 'unavailable', message: 'This file is on the host machine, so it cannot be shown in a folder here. Nothing was opened.' } })
    // A path in a paired host's message names that host's file, never one on this computer.
    await expect(f.invoke(FILES_REVEAL_LINK, f.event, { threadId: onHost.threadId, path: '/Users/me/file.pdf' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    // Its Markdown files are read on that host, and a window with no way to read them there refuses.
    await expect(f.invoke(FILES_PREVIEW_LINK, f.event, { threadId: onHost.threadId, path: '/home/me/plan.md' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    // A paired host's thread is checked as this computer's would be before anything reaches the host.
    await expect(f.invoke(FILES_PREVIEW, f.event, { ...onHost, path: '../secret' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(hosted.preview).toHaveBeenCalledOnce()
    // This computer's own threads never reach the router.
    await expect(f.invoke(FILES_LIST, f.event, request)).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(hosted.list).toHaveBeenCalledOnce()
    expect(f.resolveBinding).toHaveBeenCalledOnce(); expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
    // A window with no router refuses a paired host's thread rather than reading this computer for it.
    const bare = fixture()
    await expect(bare.invoke(FILES_LIST, bare.event, onHost)).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(bare.resolveBinding).not.toHaveBeenCalled()
  })
})
