// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerTerminalWorkspaceIpc, TERMINAL_WORKSPACE_METHODS } from '../../../src/main/terminals/ipc'
import type { TerminalWorkspaceService } from '../../../src/main/terminals/service'
import { createTerminalWorkspaceBridge } from '../../../src/preload/terminals'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'

describe('terminal workspace IPC and preload boundary', () => {
  it('serves every method to the trusted main window only, with exactly one argument', () => {
    const operation = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const service = Object.fromEntries([...TERMINAL_WORKSPACE_METHODS.map(method => [method, operation]), ['dispose', vi.fn()]]) as unknown as TerminalWorkspaceService
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const url = 'file:///main.html', mainFrame = { parent: null, url }, sender = { mainFrame, getURL: () => url, isDestroyed: () => false }
    const cleanup = registerTerminalWorkspaceIpc({ handle: (channel, fn) => { handlers.set(channel, fn) }, removeHandler: channel => { handlers.delete(channel) } }, service, () => [{ role: 'main', url, webContents: sender }])
    expect(handlers.size).toBe(10)
    for (const handler of handlers.values()) {
      expect(() => handler({ sender, senderFrame: { parent: {}, url } }, {})).toThrow('TERMINALS_MAIN_WINDOW_REQUIRED')
      expect(() => handler({ sender, senderFrame: mainFrame }, {}, {})).toThrow()
      handler({ sender, senderFrame: mainFrame }, {})
    }
    expect(operation).toHaveBeenCalledTimes(10)
    cleanup()
    expect(handlers.size).toBe(0)
    expect(service.dispose).toHaveBeenCalledOnce()
  })

  it('validates requests before they cross and results after they return', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: { code: 'busy', message: 'Later.' } })
    const bridge = createTerminalWorkspaceBridge({ invoke, on: vi.fn(), removeListener: vi.fn() })
    const launch = { provider: 'claude' as const, modelId: 'native:claude:model:x', reasoning: null, permission: 'ask' as const }
    await expect(bridge.open({ projectId: 'p', title: '', workingCopy: 'shared', launch })).rejects.toThrow()
    await expect(bridge.write({ id: 'not-a-uuid', data: 'x' })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    expect(await bridge.open({ projectId: 'p', title: 'Build', workingCopy: 'shared', launch })).toEqual({ ok: false, error: { code: 'busy', message: 'Later.' } })
    expect(invoke).toHaveBeenLastCalledWith('sotto:terminals:open', { projectId: 'p', title: 'Build', workingCopy: 'shared', launch })
    invoke.mockResolvedValueOnce({ ok: true, value: { nonsense: true } })
    await expect(bridge.list()).rejects.toThrow()
  })
})
