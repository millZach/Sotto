import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostThreadChanges } from '../../../../src/renderer/src/tools/hostThreadTools'
import type { GitChangesBridge } from '../../../../src/shared/gitChanges'

afterEach(() => { vi.useRealTimers() })

describe('Changes for a thread on a paired host', () => {
  it('asks the host for the change list on a timer while watched, says when it moved or was refused, and stops when unwatched', async () => {
    vi.useFakeTimers()
    let answer: unknown = 'r1'
    const list = vi.fn(async () => {
      if (answer instanceof Error) throw answer
      if (typeof answer !== 'string') return answer
      return { ok: true as const, value: { workspace: { threadId: 'forge:t', workspaceId: 'w' }, branch: 'master', revision: answer, files: [], truncated: false } }
    })
    const watch = vi.fn()
    const bridge = hostThreadChanges({ list, watch } as unknown as GitChangesBridge, 1000)
    const changed = vi.fn()
    bridge.onChanged(changed)
    const target = { threadId: 'forge:t', workspaceId: 'w' }
    await bridge.watch({ ...target, enabled: true })
    await bridge.watch({ ...target, enabled: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(list).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith({ ...target, revision: 'r1' })
    // The same list again says nothing; a moved one does.
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenCalledOnce()
    answer = 'r2'
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenLastCalledWith({ ...target, revision: 'r2' })
    // The host refusing the list is passed on the way this computer's own watch passes it, so the store reads it again.
    answer = { ok: false, error: { code: 'workspace-changed', message: 'The working folder changed.' } }
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenLastCalledWith({ ...target, revision: 'error:workspace-changed' })
    // A read the connection could not make says nothing.
    answer = new Error('The host is disconnected.')
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenCalledTimes(3)
    await bridge.watch({ ...target, enabled: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(5)
    // The host's own watch is never asked for: it has none to give.
    expect(watch).not.toHaveBeenCalled()
  })
})
