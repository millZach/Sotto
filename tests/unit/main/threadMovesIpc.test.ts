// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerThreadMoveIpc, type ThreadMoveCalls } from '../../../src/main/agents/threadMovesIpc'
import { THREAD_MOVE_ANSWER, THREAD_MOVE_PREPARE, THREAD_MOVE_START, THREAD_MOVES_CHANGED, THREAD_MOVES_READ, type ThreadMovesView } from '../../../src/shared/threadMoves'
import { ipcRegistry } from '../../fixtures/ipcHarness'

describe('the window’s bridge for moving threads (#1178)', () => {
  it('registers nothing where main built no service, as on stable', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerThreadMoveIpc(ipc, undefined, () => [main], () => undefined)()
    expect(handlers.size).toBe(0)
  })

  it('answers the main window only, checks each answer and removes its handlers on close', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const calls: ThreadMoveCalls = {
      prepare: vi.fn(() => ({ status: 'refused' as const, message: 'Forge isn’t connected, so nothing can move there now. Connect it, then try again. Nothing was moved.' })),
      move: vi.fn(async () => ({ status: 'ok' as const, moves: [] })),
      view: vi.fn(() => ({ cards: [] })),
      answer: vi.fn(async () => ({ status: 'refused' as const, message: 'That move isn’t waiting for an answer any more. Nothing was moved.' })),
      subscribe: vi.fn(listener => { pushed = listener; return () => { pushed = undefined } }),
    }
    let pushed: ((view: ThreadMovesView) => void) | undefined
    const sent: [string, unknown][] = []
    const close = registerThreadMoveIpc(ipc, calls, () => [main], (channel, payload) => { sent.push([channel, payload]) })
    expect(await handlers.get(THREAD_MOVE_PREPARE)!(mainEvent, { threadIds: ['a'], hostId: 'forge' })).toMatchObject({ status: 'refused' })
    expect(await handlers.get(THREAD_MOVE_START)!(mainEvent, { confirmationId: 'c' })).toEqual({ status: 'ok', moves: [] })
    expect(await handlers.get(THREAD_MOVES_READ)!(mainEvent)).toEqual({ cards: [] })
    expect(await handlers.get(THREAD_MOVE_ANSWER)!(mainEvent, { cardId: 'c', answer: 'move' })).toMatchObject({ status: 'refused' })
    await expect(handlers.get(THREAD_MOVE_ANSWER)!(widgetEvent, {})).rejects.toThrow('main Sotto window')
    expect(() => handlers.get(THREAD_MOVES_READ)!(widgetEvent)).toThrow('main Sotto window')
    // Each change goes to the main window as the cards stand.
    pushed!({ cards: [] })
    expect(sent).toEqual([[THREAD_MOVES_CHANGED, { cards: [] }]])
    expect(() => handlers.get(THREAD_MOVE_PREPARE)!(widgetEvent, {})).toThrow('main Sotto window')
    await expect(handlers.get(THREAD_MOVE_START)!(widgetEvent, {})).rejects.toThrow('main Sotto window')
    // An answer the window cannot read never crosses.
    vi.mocked(calls.prepare).mockReturnValueOnce({ status: 'refused', message: 'x', extra: true } as never)
    expect(() => handlers.get(THREAD_MOVE_PREPARE)!(mainEvent, {})).toThrow()
    close()
    expect(handlers.size).toBe(0)
    expect(pushed).toBeUndefined()
  })
})
