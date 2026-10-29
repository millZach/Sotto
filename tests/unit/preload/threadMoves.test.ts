// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge } from '../../../src/preload'
import { THREAD_MOVE_PREPARE, THREAD_MOVE_START } from '../../../src/shared/threadMoves'

describe('Moving threads in the preload (#1178, Owl cross-machine-work)', () => {
  it('exists only where the machines line does, and checks what goes and what main answers', async () => {
    const ipc = preloadElectron().ipcRenderer
    // Watcher on without Work across machines, and stable: no bridge at all.
    expect(createSottoBridge(ipc, 'win32', true).threadMoves).toBeUndefined()
    expect(createSottoBridge(ipc, 'win32').threadMoves).toBeUndefined()
    const bridge = createSottoBridge(ipc, 'win32', true, false, false, false, false, false, false, false, true).threadMoves!
    const hostId = '30b4db35-57c0-42fb-a917-695fda7d5a43', confirmationId = '07b51f0b-ed75-4abb-aea3-a014fceef088'
    const answer = { status: 'ok', confirmationId, expiresAt: '2026-10-29T10:01:00.000Z', machine: 'forge', threads: [{ threadId: 'a', outcome: 'moves' }] }
    ipc.invoke.mockResolvedValue(answer)
    await expect(bridge.prepare({ threadIds: ['a'], hostId })).resolves.toEqual(answer)
    expect(ipc.invoke).toHaveBeenLastCalledWith(THREAD_MOVE_PREPARE, { threadIds: ['a'], hostId })
    ipc.invoke.mockResolvedValue({ status: 'ok', moves: [{ threadId: 'a', outcome: 'moving', moveId: confirmationId }] })
    await expect(bridge.start({ confirmationId, threadIds: ['a'], allowNarrower: [] })).resolves.toMatchObject({ status: 'ok' })
    expect(ipc.invoke).toHaveBeenLastCalledWith(THREAD_MOVE_START, { confirmationId, threadIds: ['a'], allowNarrower: [] })
    // A request the window should not make never leaves it, and an answer main never sends is refused.
    expect(() => bridge.prepare({ threadIds: [], hostId })).toThrow()
    ipc.invoke.mockResolvedValue({ status: 'ok', moves: [{ threadId: 'a', outcome: 'moving', prompt: 'words' }] })
    await expect(bridge.start({ confirmationId, threadIds: ['a'], allowNarrower: [] })).rejects.toThrow()
  })
})
