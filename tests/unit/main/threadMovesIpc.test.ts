// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerThreadMoveIpc, type ThreadMoveCalls } from '../../../src/main/agents/threadMovesIpc'
import { THREAD_MOVE_PREPARE, THREAD_MOVE_START } from '../../../src/shared/threadMoves'
import { ipcRegistry } from '../../fixtures/ipcHarness'

describe('the window’s bridge for moving threads (#1178)', () => {
  it('registers nothing where main built no service, as on stable', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerThreadMoveIpc(ipc, undefined, () => [main])()
    expect(handlers.size).toBe(0)
  })

  it('answers the main window only, checks each answer and removes its handlers on close', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const calls: ThreadMoveCalls = {
      prepare: vi.fn(() => ({ status: 'refused' as const, message: 'Forge isn’t connected, so nothing can move there now. Connect it, then try again. Nothing was moved.' })),
      move: vi.fn(async () => ({ status: 'ok' as const, moves: [] })),
    }
    const close = registerThreadMoveIpc(ipc, calls, () => [main])
    expect(await handlers.get(THREAD_MOVE_PREPARE)!(mainEvent, { threadIds: ['a'], hostId: 'forge' })).toMatchObject({ status: 'refused' })
    expect(await handlers.get(THREAD_MOVE_START)!(mainEvent, { confirmationId: 'c' })).toEqual({ status: 'ok', moves: [] })
    expect(() => handlers.get(THREAD_MOVE_PREPARE)!(widgetEvent, {})).toThrow('main Sotto window')
    await expect(handlers.get(THREAD_MOVE_START)!(widgetEvent, {})).rejects.toThrow('main Sotto window')
    // An answer the window cannot read never crosses.
    vi.mocked(calls.prepare).mockReturnValueOnce({ status: 'refused', message: 'x', extra: true } as never)
    expect(() => handlers.get(THREAD_MOVE_PREPARE)!(mainEvent, {})).toThrow()
    close()
    expect(handlers.size).toBe(0)
  })
})
