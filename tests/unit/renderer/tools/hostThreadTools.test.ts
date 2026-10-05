import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostThreadChanges } from '../../../../src/renderer/src/tools/hostThreadTools'
import type { GitChangesBridge } from '../../../../src/shared/gitChanges'

afterEach(() => { vi.useRealTimers() })

describe('Changes for a thread on a paired host', () => {
  it('asks the host for the change list on a timer while watched, passes each revision on, and stops when unwatched', async () => {
    vi.useFakeTimers()
    let revision = 'r1'
    const list = vi.fn(async () => ({ ok: true as const, value: { workspace: { threadId: 'forge:t', workspaceId: 'w' }, branch: 'master', revision, files: [], truncated: false } }))
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
    revision = 'r2'
    await vi.advanceTimersByTimeAsync(1000)
    expect(changed).toHaveBeenLastCalledWith({ ...target, revision: 'r2' })
    await bridge.watch({ ...target, enabled: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(2)
    // The host's own watch is never asked for: it has none to give.
    expect(watch).not.toHaveBeenCalled()
  })
})
