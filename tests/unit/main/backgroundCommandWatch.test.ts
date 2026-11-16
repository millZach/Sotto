// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundCommandWatch, hermesBackgroundCommand, hermesCommandWords } from '../../../src/main/agents/backgroundCommandWatch'
import type { ChildProcessRow } from '../../../src/main/agents/detachedRunScan'

afterEach(() => { vi.useRealTimers() })
const SESSION = 'acp-session-1'
/** `session: null` is a child with no mark, as Hermes's MCP servers are. */
const row = (pid: number, argv: string[], session: string | null = SESSION, startedAt = 1_794_800_000_000): ChildProcessRow =>
  ({ pid, startedAt, argv, marks: session === null ? [] : [{ name: 'HERMES_SESSION_KEY', value: session }] })

describe('Hermes background commands (#2637)', () => {
  it('names a command by Hermes’s own form, by the line macOS gives without quotes, or as the shell left it', () => {
    expect(hermesCommandWords(['/bin/bash', '-lic', 'set +m; blender -b showroom.blend -a'])).toBe('blender -b showroom.blend -a')
    expect(hermesCommandWords(['/bin/bash', '-lic', 'set', '+m;', 'sleep', '60'])).toBe('sleep 60')
    // The shell replaced itself with the command, keeping its process.
    expect(hermesCommandWords(['sleep', '60'])).toBe('sleep 60')
    expect(hermesCommandWords([])).toBe('Background command')
  })

  it('takes a child carrying the thread’s own session, and not an MCP server or another session’s', () => {
    const ours = hermesBackgroundCommand(SESSION)
    expect(ours(row(1, ['sleep', '60']))).toBe('sleep 60')
    expect(ours(row(2, ['npx', 'mcp-server'], null))).toBeUndefined()
    expect(ours(row(3, ['sleep', '60'], 'acp-session-2'))).toBeUndefined()
    expect(hermesBackgroundCommand(undefined)(row(1, ['sleep', '60']))).toBeUndefined()
  })
})

describe('BackgroundCommandWatch (#2637)', () => {
  const setup = (lists: (readonly ChildProcessRow[] | Error)[]) => {
    vi.useFakeTimers()
    const asked: number[] = []
    let changes = 0
    const watch = new BackgroundCommandWatch({
      children: async parentPid => { asked.push(parentPid); const next = lists.shift() ?? []; if (next instanceof Error) throw next; return next },
      command: hermesBackgroundCommand(SESSION), changed: () => { changes++ },
    })
    return { watch, asked, changes: () => changes }
  }

  it('looks a few seconds after a turn ends, holds what runs, and lets each go once its process has gone', async () => {
    const render = row(41, ['/bin/bash', '-lic', 'set +m; blender -b showroom.blend -a'])
    const { watch, asked, changes } = setup([[render, row(42, ['npx', 'mcp-server'], null)], [render], []])
    watch.turnEnded(4000)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(asked).toEqual([4000])
    expect(watch.working).toMatchObject([{ type: 'command', label: 'blender -b showroom.blend -a', startedAt: new Date(1_794_800_000_000).toISOString() }])
    expect(watch.holds).toBe(true)
    const [first] = watch.working
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.working).toEqual([first])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.working).toEqual([])
    expect(watch.holds).toBe(false)
    expect(changes()).toBe(2)
    // Nothing found, nothing more looked at until the next turn ends.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toHaveLength(3)
  })

  it('looks at once when asked, so a turn’s end can be told with what it left running', async () => {
    const { watch, asked } = setup([[row(41, ['sleep', '60'])]])
    await watch.lookNow(4000, 5_000)
    expect(asked).toEqual([4000])
    expect(watch.working.map(work => work.label)).toEqual(['sleep 60'])
  })

  it('keeps what it knew when a look fails, and drops it all when stopped', async () => {
    const render = row(41, ['/bin/bash', '-lic', 'set +m; npm run render'])
    const { watch } = setup([[render], new Error('ps failed'), [render]])
    watch.turnEnded(4000)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.working.map(work => work.label)).toEqual(['npm run render'])
    watch.stop()
    expect(watch.working).toEqual([])
    watch.turnEnded(4000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(watch.working).toEqual([])
  })
})
