// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { fromWebContents: () => null }, dialog: {} }))
import { registerAgentIpc } from '../../../../src/main/agents/ipc'
import { DESKTOP_POPUP_CLIENT_ID, DESKTOP_WINDOW_CLIENT_ID } from '../../../../src/main/agents/hostService'
import { AGENT_COMMAND, AGENT_GET, type AgentState } from '../../../../src/shared/agents'
import { ipcRegistry, trustedIpcSender } from '../../../fixtures/ipcHarness'

function setup() {
  const registry = ipcRegistry()
  const popup = trustedIpcSender('popup')
  const shell = { host: { threads: [] } } as unknown as AgentState
  const command = vi.fn(async () => shell)
  const windowRead = vi.fn()
  const popupObserves = vi.fn()
  const control = { get: () => shell, shell: () => shell, threadDetail: () => null, attachmentPreview: () => null } as unknown as Parameters<typeof registerAgentIpc>[1]
  registerAgentIpc(registry.ipc, control, { command } as unknown as Parameters<typeof registerAgentIpc>[2], () => [registry.main, popup],
    { encodeReceipt: state => state as never, encodeChangedThreadRecordsReceipt: state => state as never, windowRead, popupObserves })
  return { registry, popupEvent: registry.event(popup), command, windowRead, popupObserves }
}

describe('the popup on the threads\' channels (ADR-0181)', () => {
  it('reads the shell without resetting what the main window\'s broadcasts are measured from', async () => {
    const { registry, popupEvent, windowRead } = setup()
    await registry.invoke(AGENT_GET, [], popupEvent)
    expect(windowRead).not.toHaveBeenCalled()
    await registry.invoke(AGENT_GET)
    expect(windowRead).toHaveBeenCalledOnce()
  })

  it('sends its commands as its own client, and says which threads it observes', async () => {
    const { registry, popupEvent, command, popupObserves } = setup()
    await registry.invoke(AGENT_COMMAND, [{ type: 'observe-threads', threadIds: ['t'] }], popupEvent)
    expect(popupObserves).toHaveBeenCalledWith(['t'])
    expect(command).toHaveBeenLastCalledWith({ type: 'observe-threads', threadIds: ['t'] }, expect.objectContaining({ clientId: DESKTOP_POPUP_CLIENT_ID }))
    await registry.invoke(AGENT_COMMAND, [{ type: 'interrupt', threadId: 't' }])
    expect(command).toHaveBeenLastCalledWith({ type: 'interrupt', threadId: 't' }, expect.objectContaining({ clientId: DESKTOP_WINDOW_CLIENT_ID }))
    expect(popupObserves).toHaveBeenCalledOnce()
  })

  it('refuses every command but reading, starting, prompting, stopping and answering a thread', async () => {
    const { registry, popupEvent, command } = setup()
    await expect(registry.invoke(AGENT_COMMAND, [{ type: 'delete-thread', threadId: 't' }], popupEvent)).rejects.toThrow('AGENT_POPUP_COMMAND_REFUSED')
    await expect(registry.invoke(AGENT_COMMAND, [{ type: 'select-thread', threadId: 't' }], popupEvent)).rejects.toThrow('AGENT_POPUP_COMMAND_REFUSED')
    expect(command).not.toHaveBeenCalled()
  })
})
