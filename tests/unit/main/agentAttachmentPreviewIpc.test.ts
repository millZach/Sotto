import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_ATTACHMENT_PREVIEW, type AgentState } from '../../../src/shared/agents'
import type { AgentControl } from '../../../src/main/agents/control'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII='
const request = { threadId: 'workshop', messageId: 'message', attachmentId: 'image' }
const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose(); vi.clearAllMocks() })

function fixture() {
  const listeners = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { listeners.set(channel, handler) }, removeHandler: channel => { listeners.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => {
    const url = `file:///${role}.html`
    return { role, url, webContents: { mainFrame: { parent: null, url }, isDestroyed: () => false, getURL: () => url } }
  }
  const main = sender('main'), widget = sender('widget')
  const stranger = sender('main'); stranger.webContents.getURL = () => 'https://elsewhere.test/'
  const attachmentPreview = vi.fn<AgentControl['attachmentPreview']>(() => ({ dataUrl: PNG }))
  const control = { get: () => ({} as AgentState), command: vi.fn<AgentControl['command']>(), attachmentPreview }
  disposables.push(registerAgentIpc(ipc, control, () => [main, widget], 'win32', { status: vi.fn(), download: vi.fn() },
    { synthesize: vi.fn(), voices: vi.fn(), cancel: vi.fn() }, { synthesize: vi.fn(), cancel: vi.fn() }))
  const invoke = async (payload: unknown, source = main) =>
    listeners.get(AGENT_ATTACHMENT_PREVIEW)!({ sender: source.webContents, senderFrame: source.webContents.mainFrame }, payload)
  return { invoke, attachmentPreview, main, widget, stranger, listeners }
}

describe('attachment preview IPC', () => {
  it('answers the trusted windows with the bytes main holds for that exact attachment', async () => {
    const f = fixture()
    await expect(f.invoke(request)).resolves.toEqual({ dataUrl: PNG })
    await expect(f.invoke(request, f.widget)).resolves.toEqual({ dataUrl: PNG })
    expect(f.attachmentPreview).toHaveBeenCalledWith(request)
  })

  it('reports nothing rather than an error when no eligible preview exists', async () => {
    const f = fixture()
    f.attachmentPreview.mockReturnValue(null)
    await expect(f.invoke(request)).resolves.toBeNull()
  })

  it('rejects an untrusted sender and malformed requests without reaching the store', async () => {
    const f = fixture()
    await expect(f.invoke(request, f.stranger)).rejects.toThrow('AGENT_SENDER_REJECTED')
    for (const payload of [undefined, {}, 'workshop', { ...request, extra: 1 }, { ...request, attachmentId: '' }]) {
      await expect(f.invoke(payload)).rejects.toThrow()
    }
    expect(f.attachmentPreview).not.toHaveBeenCalled()
  })

  it('removes its handler when the agent surface is torn down', () => {
    const f = fixture()
    for (const dispose of disposables.splice(0)) dispose()
    expect(f.listeners.has(AGENT_ATTACHMENT_PREVIEW)).toBe(false)
  })
})
