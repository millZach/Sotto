// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_ATTACHMENT_CONTENT, AGENT_ATTACHMENT_PREVIEW, AGENT_ATTACHMENT_STAGE, type AgentAttachmentHandle, type AgentState } from '../../../src/shared/agents'
import type { AgentControl } from '../../../src/main/agents/control'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
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
  const attachmentPreview = vi.fn<AgentControl['attachmentPreview']>(async () => ({ dataUrl: PNG }))
  const handle: AgentAttachmentHandle = { id: 'image', name: 'Shot.png', mimeType: 'image/png', sizeBytes: 8, digest: 'a'.repeat(64) }
  const stageAttachment = vi.fn(async () => handle)
  const attachmentContent = vi.fn(async () => ({ mimeType: 'image/png' as const, bytes: new Uint8Array([1]) }))
  const control = { get: () => ({} as AgentState), shell: () => ({} as AgentState), threadDetail: () => null, command: vi.fn<AgentControl['command']>(), attachmentPreview, stageAttachment, attachmentContent }
  disposables.push(registerAgentIpc(ipc, control, { command: command => control.command(command) }, () => [main, widget], { encodeReceipt: new AgentStateBroadcaster().encodeReceipt }))
  const invoke = async (payload: unknown, source = main) =>
    listeners.get(AGENT_ATTACHMENT_PREVIEW)!({ sender: source.webContents, senderFrame: source.webContents.mainFrame }, payload)
  const call = async (channel: string, payload: unknown, source = main) =>
    listeners.get(channel)!({ sender: source.webContents, senderFrame: source.webContents.mainFrame }, payload)
  return { invoke, call, attachmentPreview, stageAttachment, attachmentContent, handle, main, widget, stranger, listeners }
}

describe('attachment preview IPC', () => {
  it('answers the trusted main window with the bytes main holds for that exact attachment', async () => {
    const f = fixture()
    await expect(f.invoke(request)).resolves.toEqual({ dataUrl: PNG })
    await expect(f.invoke(request, f.widget)).rejects.toThrow('AGENT_SENDER_REJECTED')
    expect(f.attachmentPreview).toHaveBeenCalledWith(request)
  })

  it('reports nothing rather than an error when no eligible preview exists', async () => {
    const f = fixture()
    f.attachmentPreview.mockResolvedValue(null)
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

  it('stages an image for the main window and reads one back, and refuses a stranger or a malformed image (ADR-0031)', async () => {
    const f = fixture()
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const stage = { threadId: 'workshop', name: 'Shot.png', mimeType: 'image/png', bytes }
    await expect(f.call(AGENT_ATTACHMENT_STAGE, stage)).resolves.toEqual(f.handle)
    await expect(f.call(AGENT_ATTACHMENT_STAGE, { ...stage, threadId: null }, f.widget)).rejects.toThrow('AGENT_SENDER_REJECTED')
    await expect(f.call(AGENT_ATTACHMENT_CONTENT, { threadId: null, digest: f.handle.digest }, f.widget)).rejects.toThrow('AGENT_SENDER_REJECTED')
    expect(f.stageAttachment).toHaveBeenCalledWith(stage)
    await expect(f.call(AGENT_ATTACHMENT_CONTENT, { threadId: 'workshop', digest: f.handle.digest })).resolves.toEqual({ mimeType: 'image/png', bytes: new Uint8Array([1]) })
    await expect(f.call(AGENT_ATTACHMENT_STAGE, stage, f.stranger)).rejects.toThrow('AGENT_SENDER_REJECTED')
    await expect(f.call(AGENT_ATTACHMENT_CONTENT, { threadId: null, digest: f.handle.digest }, f.stranger)).rejects.toThrow('AGENT_SENDER_REJECTED')
    for (const payload of [{ ...stage, mimeType: 'image/svg+xml' }, { ...stage, bytes: 'data:image/png;base64,AAAA' }, { ...stage, bytes: new Uint8Array() },
      { ...stage, bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, { ...stage, extra: 1 }]) {
      await expect(f.call(AGENT_ATTACHMENT_STAGE, payload)).rejects.toThrow()
    }
    await expect(f.call(AGENT_ATTACHMENT_CONTENT, { threadId: null, digest: '../secret' })).rejects.toThrow()
    expect(f.stageAttachment).toHaveBeenCalledTimes(1)
  })

  it('removes its handler when the agent surface is torn down', () => {
    const f = fixture()
    for (const dispose of disposables.splice(0)) dispose()
    expect(f.listeners.has(AGENT_ATTACHMENT_PREVIEW)).toBe(false)
    expect(f.listeners.has(AGENT_ATTACHMENT_STAGE)).toBe(false)
    expect(f.listeners.has(AGENT_ATTACHMENT_CONTENT)).toBe(false)
  })
})
