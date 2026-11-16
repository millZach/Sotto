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
  it('names a command as Hermes was asked to run it, and once the shell has replaced itself, by its program alone', () => {
    // The script is the command before the shell expands anything, as the thread's own step shows it.
    expect(hermesCommandWords(['/bin/bash', '-lic', 'set +m; deploy --api "$API_TOKEN"'])).toBe('deploy --api "$API_TOKEN"')
    expect(hermesCommandWords(['/bin/bash', '-lic', 'set', '+m;', 'sleep', '60'])).toBe('sleep 60')
    // Replaced by the command, the process holds expanded values: a token must never be shown (#2652, L1).
    const label = hermesCommandWords(['/usr/bin/python3', '-c', 'import time;time.sleep(8)', '--api', 'sk-live-SECRET123'])
    expect(label).toBe('python3')
    expect(label).not.toContain('SECRET')
    expect(hermesCommandWords(['C:\\Tools\\deploy.exe', 'sk-live-SECRET123'])).toBe('deploy')
    expect(hermesCommandWords([])).toBe('Background command')
  })

  it('takes a child carrying the thread’s own session, and not an MCP server or another session’s', () => {
    const ours = hermesBackgroundCommand(SESSION)
    expect(ours(row(1, ['sleep', '60']))).toBe('sleep')
    expect(ours(row(2, ['npx', 'mcp-server'], null))).toBeUndefined()
    expect(ours(row(3, ['sleep', '60'], 'acp-session-2'))).toBeUndefined()
    expect(hermesBackgroundCommand(undefined)(row(1, ['sleep', '60']))).toBeUndefined()
  })
})

describe('BackgroundCommandWatch (#2637)', () => {
  const setup = (lists: (readonly ChildProcessRow[] | Error)[], state = { turnRunning: false }) => {
    vi.useFakeTimers()
    const asked: number[] = []
    let changes = 0
    const watch = new BackgroundCommandWatch({
      children: async parentPid => { asked.push(parentPid); const next = lists.shift() ?? []; if (next instanceof Error) throw next; return next },
      command: hermesBackgroundCommand(SESSION), changed: () => { changes++ }, admitting: () => !state.turnRunning,
    })
    return { watch, asked, changes: () => changes, state }
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
    expect(watch.working.map(work => work.label)).toEqual(['sleep'])
  })

  it('takes no command a running turn runs, though it carries the same mark, and keeps the one it held (#2652, L2)', async () => {
    const server = row(41, ['/bin/bash', '-lic', 'set +m; npm run dev'])
    const test = row(52, ['/bin/bash', '-lic', 'set +m; npm test'])
    const { watch, state } = setup([[server], [server, test], [server, test]])
    watch.turnEnded(4000)
    await vi.advanceTimersByTimeAsync(3_000)
    state.turnRunning = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.working.map(work => work.label)).toEqual(['npm run dev'])
    // Once that turn has ended, a command still running then is one it left in the background.
    state.turnRunning = false
    await vi.advanceTimersByTimeAsync(15_000)
    expect(watch.working.map(work => work.label)).toEqual(['npm run dev', 'npm test'])
  })

  it('drops a look that comes back after a newer one started, so an ended command is not brought back (#2652, N2)', async () => {
    vi.useFakeTimers()
    const answers: ((rows: ChildProcessRow[]) => void)[] = []
    const watch = new BackgroundCommandWatch({ children: () => new Promise(resolve => { answers.push(resolve) }),
      command: hermesBackgroundCommand(SESSION), changed: () => undefined, admitting: () => true })
    const slow = watch.lookNow(4000, 5_000)
    await vi.advanceTimersByTimeAsync(5_000); await slow
    // A newer look starts and answers that the command has ended; then the first, older look answers.
    watch.turnEnded(4000)
    await vi.advanceTimersByTimeAsync(3_000)
    answers[1]!([])
    await vi.advanceTimersByTimeAsync(0)
    answers[0]!([row(41, ['sleep', '60'])])
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.working).toEqual([])
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
