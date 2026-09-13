import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, type FileListRequest, type FileRequest } from '../../../src/shared/files'

const workspace = { threadId: 'thread', projectId: 'project', workingDirectory: 'C:/project', workspaceId: 'a'.repeat(64) }
const request = { threadId: 'thread', path: 'file.md', workspaceId: workspace.workspaceId }
describe('Files preload contract', () => {
  it('exposes only the four typed methods on the main window, parses requests and replies', async () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const bridge = createSottoBridge(ipc, 'win32').files!
    expect(Object.keys(bridge).sort()).toEqual(['copyPath', 'list', 'preview', 'reveal'])
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
      expect(await bridge[method](request)).toEqual(reply)
      expect(ipc.invoke).toHaveBeenLastCalledWith(channel, request)
    }
  })
  it('does not dispatch invalid paths, root overrides or tokenless stale selections', () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const bridge = createSottoBridge(ipc, 'win32').files!
    expect(() => bridge.list({ threadId: 'thread', path: '', root: 'C:/' } as FileListRequest)).toThrow()
    expect(() => bridge.list({ threadId: 'thread', path: 'subdir' })).toThrow()
    for (const method of ['preview', 'copyPath', 'reveal'] as const) {
      expect(() => bridge[method]({ threadId: 'thread', path: 'file' } as FileRequest)).toThrow()
      expect(() => bridge[method]({ ...request, path: '../secret' })).toThrow()
    }
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
  it('returns recoverable errors and rejects malformed or active-content image replies', async () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
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
