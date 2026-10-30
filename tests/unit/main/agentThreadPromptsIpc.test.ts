import { ipcRegistry } from '../../fixtures/ipcHarness'
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import type { AgentState } from '../../../src/shared/agents'
import { AGENT_THREAD_PROMPTS, type AgentThreadPrompts, type AgentThreadPromptsRequest } from '../../../src/shared/threadPrompts'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' }, BrowserWindow: { fromWebContents: vi.fn() }, dialog: { showOpenDialog: vi.fn() } }))
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { registerAgentIpc } from '../../../src/main/agents/ipc'

const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose() })

const read: AgentThreadPrompts = { prompts: [{ id: 'u0', createdAt: '2026-10-24T09:00:00.000Z', text: 'Why does the pill flicker?' }] }

function fixture(threadPrompts?: (request: AgentThreadPromptsRequest) => Promise<AgentThreadPrompts | null>) {
  const registry = ipcRegistry()
  const { ipc, main, widget } = registry
  const control = { get: vi.fn<() => AgentState>(), shell: vi.fn<() => AgentState>(), threadDetail: vi.fn(() => null), attachmentPreview: vi.fn(() => null), ...(threadPrompts ? { threadPrompts } : {}) }
  disposables.push(registerAgentIpc(ipc, control, { command: vi.fn() }, () => [main, widget], { encodeReceipt: new AgentStateBroadcaster().encodeReceipt, encodeThreadChangesReceipt: new AgentStateBroadcaster().encodeThreadChangesReceipt }))
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const fromWidget: IpcInvocationEvent = { sender: widget.webContents, senderFrame: widget.webContents.mainFrame }
  return { invoke: (source: IpcInvocationEvent, payload: unknown) => registry.invoke(AGENT_THREAD_PROMPTS, [payload], source), event, fromWidget }
}

describe('the message scrubber’s prompts IPC (ADR-0109)', () => {
  it('reads the prompts above a window for the main window, and refuses other senders and malformed requests', async () => {
    const threadPrompts = vi.fn(async () => read)
    const f = fixture(threadPrompts)
    await expect(f.invoke(f.event, { threadId: 'host:thread', beforeMessageId: 'u3' })).resolves.toEqual(read)
    expect(threadPrompts).toHaveBeenCalledExactlyOnceWith({ threadId: 'host:thread', beforeMessageId: 'u3' })
    await expect(f.invoke(f.fromWidget, { threadId: 'host:thread', beforeMessageId: 'u3' })).rejects.toThrow()
    await expect(f.invoke(f.event, { threadId: 'host:thread' })).rejects.toThrow()
    await expect(f.invoke(f.event, { threadId: 'host:thread', beforeMessageId: 'u3', extra: true })).rejects.toThrow()
    expect(threadPrompts).toHaveBeenCalledTimes(1)
  })

  it('answers null where nothing keeps a store', async () => {
    const f = fixture()
    await expect(f.invoke(f.event, { threadId: 'thread', beforeMessageId: 'u3' })).resolves.toBeNull()
  })
})
