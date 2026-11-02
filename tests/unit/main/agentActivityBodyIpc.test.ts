import { ipcRegistry } from '../../fixtures/ipcHarness'
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import { AGENT_ACTIVITY_BODY, type AgentState } from '../../../src/shared/agents'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' }, BrowserWindow: { fromWebContents: vi.fn() }, dialog: { showOpenDialog: vi.fn() } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'
import { receiptEncoders } from '../../fixtures/receiptEncoders'

const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose() })

const whole = { id: 'build', turnId: 'turn', sequence: 0, kind: 'command' as const, status: 'completed' as const, title: 'Ran npm test', output: 'every line' }

function fixture(activityBody?: (request: { threadId: string; activityId: string }) => Promise<typeof whole | null>) {
  const registry = ipcRegistry()
  const { ipc, main, widget } = registry
  const control = { get: vi.fn<() => AgentState>(), shell: vi.fn<() => AgentState>(), threadDetail: vi.fn(() => null), attachmentPreview: vi.fn(() => null), ...(activityBody ? { activityBody } : {}) }
  disposables.push(registerAgentIpc(ipc, control, { command: vi.fn() }, () => [main, widget], { ...receiptEncoders() }))
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const fromWidget: IpcInvocationEvent = { sender: widget.webContents, senderFrame: widget.webContents.mainFrame }
  return { invoke: (source: IpcInvocationEvent, payload: unknown) => registry.invoke(AGENT_ACTIVITY_BODY, [payload], source), event, fromWidget }
}

describe('activity body IPC (ADR-0025, October 18 amendment)', () => {
  it('reads one record whole for the main window, and refuses other senders and malformed requests', async () => {
    const activityBody = vi.fn(async () => whole)
    const f = fixture(activityBody)
    await expect(f.invoke(f.event, { threadId: 'host:thread', activityId: 'build' })).resolves.toEqual(whole)
    expect(activityBody).toHaveBeenCalledExactlyOnceWith({ threadId: 'host:thread', activityId: 'build' })
    await expect(f.invoke(f.fromWidget, { threadId: 'host:thread', activityId: 'build' })).rejects.toThrow()
    await expect(f.invoke(f.event, { threadId: 'host:thread' })).rejects.toThrow()
    await expect(f.invoke(f.event, { threadId: 'host:thread', activityId: 'build', extra: true })).rejects.toThrow()
    expect(activityBody).toHaveBeenCalledTimes(1)
  })

  it('answers null where nothing can hold a cut body', async () => {
    const f = fixture()
    await expect(f.invoke(f.event, { threadId: 'thread', activityId: 'build' })).resolves.toBeNull()
  })
})
