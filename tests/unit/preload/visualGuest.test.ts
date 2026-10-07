/**
 * Sotto's preload in an interactive visual's sealed page (ADR-0057): it passes steps and the theme on as window
 * messages, and only the user's own Escape gives focus back to Sotto. A key the page dispatches itself moves nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { returnsFocus, VISUAL_IPC_ESCAPE, VISUAL_IPC_STEP } from '../../../src/shared/visualGuest'

const ipc = vi.hoisted(() => ({ on: vi.fn(), sendToHost: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} })
  await import('../../../src/preload/visual')
})
afterAll(() => { vi.unstubAllGlobals() })

describe('the guest preload', () => {
  it('gives focus back only for the user\'s own Escape', () => {
    expect(returnsFocus({ key: 'Escape', repeat: false, isTrusted: true })).toBe(true)
    expect(returnsFocus({ key: 'Escape', repeat: false, isTrusted: false })).toBe(false)
    expect(returnsFocus({ key: 'Escape', repeat: true, isTrusted: true })).toBe(false)
    expect(returnsFocus({ key: 'Enter', repeat: false, isTrusted: true })).toBe(false)
  })

  it('ignores an Escape the page dispatches itself', () => {
    ipc.sendToHost.mockClear()
    for (let index = 0; index < 50; index++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(ipc.sendToHost.mock.calls.filter(call => call[0] === VISUAL_IPC_ESCAPE)).toEqual([])
  })

  it('passes a well-formed step on as a window message, and drops anything else', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    const receive = ipc.on.mock.calls.find(call => call[0] === VISUAL_IPC_STEP)![1] as (event: unknown, value: unknown) => void
    receive({}, { step: 1, total: 2, highlight: ['queue'] })
    receive({}, { step: 9, total: 2, highlight: [] })
    expect(post.mock.calls).toEqual([[{ type: 'sotto-visual-step', step: 1, total: 2, highlight: ['queue'] }, '*']])
    post.mockRestore()
  })
})
