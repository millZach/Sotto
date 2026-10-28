// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge } from '../../../src/preload'
import { CHECK_QUEUES_READ } from '../../../src/shared/checkQueue'

describe('Every machine’s check queue in the preload (#1312, Owl cross-machine-work)', () => {
  it('exists only where the machines line does, and checks what main answers', async () => {
    const ipc = preloadElectron().ipcRenderer
    // Watcher on without Work across machines, and stable: no bridge at all.
    expect(createSottoBridge(ipc, 'win32', true).checks).toBeUndefined()
    expect(createSottoBridge(ipc, 'win32').checks).toBeUndefined()
    const bridge = createSottoBridge(ipc, 'win32', true, false, false, false, false, false, false, false, true).checks!
    const answer = { machines: [{ hostId: 'local', thisComputer: true, checks: [{ id: 'one', whose: 'watcher', title: 'Capture check' }] }] }
    ipc.invoke.mockResolvedValue(answer)
    await expect(bridge.read()).resolves.toEqual(answer)
    expect(ipc.invoke).toHaveBeenLastCalledWith(CHECK_QUEUES_READ)
    // A brief, or anything else main never sends, is refused.
    ipc.invoke.mockResolvedValue({ machines: [{ hostId: 'local', thisComputer: true, checks: [{ id: 'one', brief: 'Run the suite' }] }] })
    await expect(bridge.read()).rejects.toThrow()
    expect(bridge.onChanged(() => undefined)).toBeTypeOf('function')
  })
})
