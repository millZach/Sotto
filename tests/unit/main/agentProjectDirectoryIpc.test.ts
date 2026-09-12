import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, type AgentState } from '../../../src/shared/agents'

const native = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => 'D:/fixture' },
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
}))
vi.mock('electron', () => ({ app: native.app, BrowserWindow: { fromWebContents: native.fromWebContents }, dialog: { showOpenDialog: native.showOpenDialog } }))
vi.mock('../../../src/main/agents/wake', () => ({ AgentWakeService: class { dispose() {} } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'

const disposables: Array<() => void> = []
beforeEach(() => {
  native.app.isPackaged = false
  vi.stubEnv('SOTTO_E2E', undefined)
  vi.stubEnv('SOTTO_E2E_SCENARIO', undefined)
  vi.stubEnv('SOTTO_E2E_USER_DATA', undefined)
  vi.stubEnv('SOTTO_E2E_PROJECT_DIRECTORY', undefined)
})
afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function fixture() {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => {
    const url = `file:///${role}.html`
    const mainFrame = { parent: null, url }
    return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } }
  }
  const main = sender('main'), widget = sender('widget')
  const control = { get: vi.fn<() => AgentState>(), command: vi.fn() }
  const parent = { isDestroyed: () => false }
  native.fromWebContents.mockReturnValue(parent)
  native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\Existing Folder\\project'] })
  const dispose = registerAgentIpc(ipc, control, () => [main, widget], 'win32', { status: vi.fn(), download: vi.fn() }, { synthesize: vi.fn(), voices: vi.fn(), cancel: vi.fn() }, { synthesize: vi.fn(), cancel: vi.fn() })
  disposables.push(dispose)
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const invoke = async (source = event, ...args: unknown[]) => handlers.get(AGENT_CHOOSE_PROJECT_DIRECTORY)!(source, ...args)
  return { invoke, event, main, widget, parent, control, handlers, dispose }
}

function enableE2E() {
  vi.stubEnv('SOTTO_E2E', '1')
  vi.stubEnv('SOTTO_E2E_SCENARIO', 'success')
  vi.stubEnv('SOTTO_E2E_USER_DATA', process.cwd())
}

describe('project directory picker IPC', () => {
  it('allows trusted main, parents the directory-only dialog to its window and returns the exact selection without project commands', async () => {
    const f = fixture()
    await expect(f.invoke()).resolves.toBe('D:\\Existing Folder\\project')
    expect(native.fromWebContents).toHaveBeenCalledExactlyOnceWith(f.main.webContents)
    expect(native.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.parent, { properties: ['openDirectory'] })
    expect(f.control.command).not.toHaveBeenCalled()
    expect(f.control.get).not.toHaveBeenCalled()
  })

  it.each([
    { canceled: true, filePaths: ['ignored'] },
    { canceled: false, filePaths: [] },
  ])('returns null for cancellation or an empty selection: %j', async result => {
    const f = fixture()
    native.showOpenDialog.mockResolvedValueOnce(result)
    await expect(f.invoke()).resolves.toBeNull()
    expect(f.control.command).not.toHaveBeenCalled()
  })

  it('rejects widget, foreign, child, spoofed top-level, missing and navigated frames before window lookup', async () => {
    const f = fixture()
    const rejected: IpcInvocationEvent[] = [
      { sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame },
      { ...f.event, sender: { ...f.main.webContents } },
      { ...f.event, senderFrame: { parent: {}, url: f.main.url } },
      { ...f.event, senderFrame: { parent: null, url: f.main.url } },
      { ...f.event, senderFrame: null },
    ]
    for (const event of rejected) await expect(f.invoke(event)).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    f.main.webContents.getURL = () => 'https://untrusted.example/'
    await expect(f.invoke()).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    expect(native.fromWebContents).not.toHaveBeenCalled()
    expect(native.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects destroyed senders and missing or destroyed parent windows', async () => {
    const f = fixture()
    f.main.webContents.isDestroyed = () => true
    await expect(f.invoke()).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    expect(native.fromWebContents).not.toHaveBeenCalled()
    f.main.webContents.isDestroyed = () => false
    native.fromWebContents.mockReturnValueOnce(null).mockReturnValueOnce({ isDestroyed: () => true })
    await expect(f.invoke()).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    await expect(f.invoke()).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    expect(native.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects payloads and extra arguments before opening a dialog', async () => {
    const f = fixture()
    for (const args of [[{}], ['D:/folder'], [null], [undefined, 'extra']]) {
      await expect(f.invoke(f.event, ...args)).rejects.toThrow()
    }
    expect(native.showOpenDialog).not.toHaveBeenCalled()
  })

  it('propagates dialog failures and unregisters on disposal', async () => {
    const f = fixture()
    native.showOpenDialog.mockRejectedValueOnce(new Error('Dialog unavailable'))
    await expect(f.invoke()).rejects.toThrow('Dialog unavailable')
    f.dispose()
    expect(f.handlers.has(AGENT_CHOOSE_PROJECT_DIRECTORY)).toBe(false)
  })

  it('uses only an existing absolute E2E directory and treats an absent override as cancellation', async () => {
    enableE2E()
    const f = fixture()
    await expect(f.invoke()).resolves.toBeNull()
    vi.stubEnv('SOTTO_E2E_PROJECT_DIRECTORY', process.cwd())
    await expect(f.invoke()).resolves.toBe(process.cwd())
    await expect(f.invoke({ sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame })).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    for (const path of ['relative', join(process.cwd(), 'CLAUDE.md'), join(process.cwd(), '__missing_picker_fixture__')]) {
      vi.stubEnv('SOTTO_E2E_PROJECT_DIRECTORY', path)
      await expect(f.invoke()).rejects.toThrow()
    }
    expect(native.showOpenDialog).not.toHaveBeenCalled()
    expect(f.control.command).not.toHaveBeenCalled()
  })

  it.each(['live', 'packaged', 'invalid-scenario', 'missing-user-data'])('ignores the deterministic override for %s mode', async mode => {
    enableE2E()
    if (mode === 'live') vi.stubEnv('SOTTO_E2E', undefined)
    if (mode === 'invalid-scenario') vi.stubEnv('SOTTO_E2E_SCENARIO', 'invalid')
    if (mode === 'missing-user-data') vi.stubEnv('SOTTO_E2E_USER_DATA', undefined)
    vi.stubEnv('SOTTO_E2E_PROJECT_DIRECTORY', process.cwd())
    const f = fixture()
    if (mode === 'packaged') native.app.isPackaged = true
    await expect(f.invoke()).resolves.toBe('D:\\Existing Folder\\project')
    expect(native.showOpenDialog).toHaveBeenCalledOnce()
  })
})
