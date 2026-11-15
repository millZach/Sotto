// @vitest-environment node
import { preloadElectron } from '../../fixtures/preloadElectron'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { preloadElectron } = await import('../../fixtures/preloadElectron')
  return preloadElectron()
})
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, FILES_REVEAL_LINK, FILES_PREVIEW_LINK, FILES_OPEN_LINK, FILES_LINKED_FILE, FILES_DOWNLOAD, FILES_DOWNLOAD_STOP, FILES_DOWNLOAD_SHOW, FILES_DOWNLOAD_OPEN, FILES_DOWNLOAD_PROGRESS, type FileListRequest, type FileRequest, type LinkedFileViewRequest } from '../../../src/shared/files'

const workspace = { threadId: 'thread', projectId: 'project', workingDirectory: 'C:/project', workspaceId: 'a'.repeat(64) }
const request = { threadId: 'thread', path: 'file.md', workspaceId: workspace.workspaceId }
describe('Files preload contract', () => {
  it('exposes only its typed methods on the main window, parses requests and replies', async () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'win32').files!
    expect(Object.keys(bridge).sort()).toEqual(['copyPath', 'download', 'linkedFile', 'list', 'onDownloadProgress', 'openDownload', 'openLink', 'preview', 'previewLink', 'reveal', 'revealLink', 'showDownload', 'stopDownload'])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('files')
    const listing = { ok: true, value: { workspace, path: '', entries: [{ name: 'file.md', path: 'file.md', kind: 'file' }], truncated: false } }
    ipc.invoke.mockResolvedValueOnce(listing)
    expect(await bridge.list({ threadId: 'thread', path: '' })).toEqual(listing)
    expect(ipc.invoke).toHaveBeenLastCalledWith(FILES_LIST, { threadId: 'thread', path: '' })
    const preview = { ok: true, value: { workspace, path: 'file.md', name: 'file.md', size: 4, content: { kind: 'markdown', text: '# Hi' } } }
    ipc.invoke.mockResolvedValueOnce(preview)
    expect(await bridge.preview(request)).toEqual(preview)
    expect(ipc.invoke).toHaveBeenLastCalledWith(FILES_PREVIEW, request)
    for (const [method, channel] of [['copyPath', FILES_COPY_PATH], ['reveal', FILES_REVEAL]] as const) {
      const reply = { ok: true, value: { workspace, path: 'file.md', absolutePath: 'C:/project/file.md' } }
      ipc.invoke.mockResolvedValueOnce(reply)
      expect(await bridge[method]!(request)).toEqual(reply)
      expect(ipc.invoke).toHaveBeenLastCalledWith(channel, request)
    }
    const link = { threadId: 'thread', path: 'C:/Users/me/file.pdf' }
    ipc.invoke.mockResolvedValueOnce({ ok: true, value: {} })
    expect(await bridge.revealLink!(link)).toEqual({ ok: true, value: {} })
    expect(ipc.invoke).toHaveBeenLastCalledWith(FILES_REVEAL_LINK, link)
    ipc.invoke.mockResolvedValueOnce({ ok: true, value: { name: 'a.md', size: 1, text: 'a' } })
    expect(await bridge.previewLink!(link)).toEqual({ ok: true, value: { name: 'a.md', size: 1, text: 'a' } })
    expect(ipc.invoke).toHaveBeenLastCalledWith(FILES_PREVIEW_LINK, link)
  })
  it('opens, finds and downloads a linked file through checked requests and replies (ADR-0120, November 12 amendment)', async () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'win32').files!
    const link = { threadId: 'thread', path: '/home/me/out/report.pdf' }, handle = { downloadId: 'a'.repeat(32) }
    const calls = [
      [() => bridge.openLink!(link), FILES_OPEN_LINK, link, { ok: true, value: { did: 'shown' } }],
      [() => bridge.linkedFile!({ ...link, want: 'place' }), FILES_LINKED_FILE, { ...link, want: 'place' }, { ok: true, value: { is: 'place', name: 'report.pdf', kind: 'file', size: 3, inside: null } }],
      [() => bridge.linkedFile!({ ...link, want: 'preview' }), FILES_LINKED_FILE, { ...link, want: 'preview' }, { ok: true, value: { is: 'preview', name: 'a.txt', size: 1, content: { kind: 'text', text: 'a' } } }],
      [() => bridge.download!(link), FILES_DOWNLOAD, link, { ok: true, value: { ...handle, name: 'report.pdf', size: 3 } }],
      [() => bridge.stopDownload!(link), FILES_DOWNLOAD_STOP, link, { ok: true, value: { stopped: true } }],
      [() => bridge.showDownload!(handle), FILES_DOWNLOAD_SHOW, handle, { ok: true, value: {} }],
      [() => bridge.openDownload!(handle), FILES_DOWNLOAD_OPEN, handle, { ok: true, value: { did: 'opened' } }],
    ] as const
    for (const [call, channel, sent, reply] of calls) {
      ipc.invoke.mockResolvedValueOnce(reply)
      expect(await call()).toEqual(reply)
      expect(ipc.invoke).toHaveBeenLastCalledWith(channel, sent)
    }
    const sent = ipc.invoke.mock.calls.length
    // The window cannot ask for a file's bytes, name a saved file by a path, or reach a network share.
    await expect(bridge.linkedFile!({ ...link, want: 'part', offset: 0 } as unknown as LinkedFileViewRequest)).rejects.toThrow()
    await expect(bridge.showDownload!({ downloadId: '../report.pdf' })).rejects.toThrow()
    await expect(bridge.download!({ threadId: 'thread', path: '//evil.example/share/a.pdf' })).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledTimes(sent)
    // A reply carrying a file's bytes, or where a download was saved, is not handed to the window.
    ipc.invoke.mockResolvedValueOnce({ ok: true, value: { is: 'part', name: 'report.pdf', size: 3, offset: 0, data: 'MTIz', revision: 'a'.repeat(64) } })
    await expect(bridge.linkedFile!({ ...link, want: 'place' })).rejects.toThrow()
    ipc.invoke.mockResolvedValueOnce({ ok: true, value: { ...handle, name: 'report.pdf', size: 3, path: 'C:/Users/me/Downloads/report.pdf' } })
    await expect(bridge.download!(link)).rejects.toThrow()
    // Progress arrives checked, and an unsubscribed listener hears nothing more.
    const heard = vi.fn()
    const unsubscribe = bridge.onDownloadProgress!(heard)
    const listener = ipc.on.mock.calls.find(([channel]) => channel === FILES_DOWNLOAD_PROGRESS)![1] as (event: unknown, ...args: unknown[]) => void
    listener({}, { ...link, received: 2, size: 3 }); listener({}, { ...link, received: 'most' })
    expect(heard.mock.calls).toEqual([[{ ...link, received: 2, size: 3 }]])
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(FILES_DOWNLOAD_PROGRESS, listener)
  })
  it('rejects invalid paths, root overrides or tokenless stale selections without dispatch', async () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'win32').files!
    await expect(bridge.list({ threadId: 'thread', path: '', root: 'C:/' } as FileListRequest)).rejects.toThrow()
    await expect(bridge.list({ threadId: 'thread', path: 'subdir' })).rejects.toThrow()
    for (const method of ['preview', 'copyPath', 'reveal'] as const) {
      await expect(bridge[method]!({ threadId: 'thread', path: 'file' } as FileRequest)).rejects.toThrow()
      await expect(bridge[method]!({ ...request, path: '../secret' })).rejects.toThrow()
    }
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
  it('returns recoverable errors and rejects malformed or active-content image replies', async () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'win32').files!
    const unavailable = { ok: false, error: { code: 'workspace-changed', message: 'Refresh Files.' } }
    ipc.invoke.mockResolvedValueOnce(unavailable)
    expect(await bridge.preview(request)).toEqual(unavailable)
    for (const content of [
      { kind: 'image', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml,<svg></svg>' },
      { kind: 'image', mime: 'image/png', dataUrl: 'file:///C:/secret.png' },
      { kind: 'html', text: '<script>bad()</script>' },
    ]) {
      ipc.invoke.mockResolvedValueOnce({ ok: true, value: { workspace, path: 'file.md', name: 'file.md', size: 4, content } })
      await expect(bridge.preview(request)).rejects.toThrow()
    }
  })
})
