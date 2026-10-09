// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  buildLinuxPasteInvocation, buildHyprlandKeyInvocation, createHyprlandPasteAdapter,
  hyprlandPasteChord, MODIFIERS_HELD_QUERY,
} from '../../../src/main/output/pasteCommand.linux'
import { OutputService } from '../../../src/main/output/outputService'
import { createPasteCommands, type PasteInvocation } from '../../../src/main/output/pasteCommand'
import { buildDarwinPasteInvocation } from '../../../src/main/output/pasteCommand.darwin'
import { buildPasteInvocation as buildWindowsPasteInvocation } from '../../../src/main/output/pasteCommand.win32'

function harness(tags: unknown = []) {
  let clock = 0
  const run = vi.fn(async (invocation: PasteInvocation) => {
    switch (invocation.args[0]) {
      case 'locked': return '{"locked":false}'
      case 'repl': return 'false'
      case 'activewindow': return JSON.stringify({ tags })
      default: return 'ok'
    }
  })
  const delay = vi.fn(async (ms: number) => { clock += ms })
  const copyToPrimary = vi.fn(async () => undefined)
  return { run, delay, copyToPrimary, adapter: createHyprlandPasteAdapter(run, delay, () => clock, copyToPrimary), advance: (ms: number) => { clock += ms } }
}

const dispatched = (run: ReturnType<typeof harness>['run']) => run.mock.calls
  .map(([invocation]) => invocation).filter(invocation => invocation.args[0] === 'dispatch')

describe('Hyprland paste', () => {
  it.each([
    [undefined, 'CTRL', 'V'], [null, 'CTRL', 'V'], [{}, 'CTRL', 'V'],
    [{ tags: ['browser'] }, 'CTRL', 'V'], [{ tags: ['terminal'] }, 'SHIFT', 'Insert'],
    [{ tags: ['other', 'terminal*'] }, 'SHIFT', 'Insert'],
    [{ tags: ['terminal-other', 'terminal**', 'Terminal'] }, 'CTRL', 'V'],
    [{ tags: 'terminal' }, 'CTRL', 'V'],
  ])('selects the Omarchy chord from %j', (window, mods, key) => {
    expect(hyprlandPasteChord(window)).toEqual({ mods, key })
  })

  it.each([[], ['terminal'], ['terminal*']])('constructs down/up Lua argument arrays for tags %j', async (...tags) => {
    const h = harness(tags.flat())
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(true)
    const chord = hyprlandPasteChord({ tags: tags.flat() })
    expect(h.run.mock.calls.slice(0, 4).map(([i]) => i.args)).toEqual([
      ['locked', '-j'], ['repl', MODIFIERS_HELD_QUERY], ['activewindow', '-j'],
      ['locked', '-j'],
    ])
    expect(dispatched(h.run)).toEqual(['down', 'up'].map(state => ({
      executable: 'hyprctl',
      args: ['dispatch', `hl.dsp.send_key_state({ mods = "${chord.mods}", key = "${chord.key}", state = "${state}" })`],
    })))
    expect(h.delay.mock.calls).toEqual([[50]])
  })

  it.each([[], ['terminal']])('prepares PRIMARY only for terminal tags %j before the final lock check', async (...tags) => {
    const h = harness(tags.flat())
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(async i => {
      if (i.args[0] === 'dispatch') expect(h.copyToPrimary).toHaveBeenCalledTimes(tags.flat().length)
      return base(i)
    })
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(true)
    if (tags.flat().length) {
      expect(h.copyToPrimary.mock.invocationCallOrder[0]).toBeLessThan(h.run.mock.invocationCallOrder[3]!)
    }
  })

  it('leaves text copied without keys if PRIMARY cannot be updated', async () => {
    const h = harness(['terminal'])
    h.copyToPrimary.mockRejectedValue(new Error('unavailable'))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(dispatched(h.run)).toEqual([])
  })

  it('waits briefly for physical modifiers to be released before querying the target', async () => {
    const h = harness()
    let checks = 0
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(i => i.args[0] === 'repl' ? Promise.resolve(++checks <= 2 ? 'true' : 'false') : base(i))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(true)
    expect(h.delay.mock.calls).toEqual([[25], [25], [50]])
    expect(h.run.mock.calls.findIndex(([i]) => i.args[0] === 'activewindow')).toBe(4)
  })

  it.each(['modifier wait', 'target query'])('sends no down when the session locks during the %s', async phase => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    let locked = false
    let checks = 0
    h.run.mockImplementation(async i => {
      if (i.args[0] === 'locked') return JSON.stringify({ locked })
      if (i.args[0] === 'repl' && phase === 'modifier wait' && ++checks === 1) return 'true'
      if (i.args[0] === 'activewindow' && phase === 'target query') locked = true
      return base(i)
    })
    h.delay.mockImplementation(async () => { locked = true })
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(dispatched(h.run)).toEqual([])
  })

  it('sends no down when the final lock query fails', async () => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    let lockChecks = 0
    h.run.mockImplementation(i => i.args[0] === 'locked' && ++lockChecks === 2
      ? Promise.reject(new Error('unavailable')) : base(i))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(dispatched(h.run)).toEqual([])
  })

  it('still releases the key when the session locks between down and up', async () => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    let locked = false
    h.run.mockImplementation(i => i.args[0] === 'locked' ? Promise.resolve(JSON.stringify({ locked })) : base(i))
    h.delay.mockImplementation(async () => { locked = true })
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(true)
    expect(locked).toBe(true)
    expect(dispatched(h.run)).toEqual(['down', 'up'].map(state =>
      buildHyprlandKeyInvocation({ mods: 'CTRL', key: 'V' }, state as 'down' | 'up')))
  })

  it('leaves the result copied if a modifier stays held for 300 ms', async () => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(i => i.args[0] === 'repl' ? Promise.resolve('true') : base(i))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(h.delay.mock.calls).toEqual(Array.from({ length: 12 }, () => [25]))
    expect(dispatched(h.run)).toEqual([])
  })

  it('bounds a slow modifier query by the remaining budget and sends no keys', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn(async (i: PasteInvocation, timeout?: number) => {
        if (i.args[0] === 'locked') return '{"locked":false}'
        expect(timeout).toBe(300)
        return new Promise<string>(resolve => setTimeout(() => resolve('false'), 301))
      })
      const adapter = createHyprlandPasteAdapter(run, undefined, () => performance.now())
      const result = adapter.run(buildLinuxPasteInvocation())
      await vi.advanceTimersByTimeAsync(300)
      await expect(result).resolves.toBe(false)
      expect(run.mock.calls[1]![1]).toBe(300)
      await vi.advanceTimersByTimeAsync(1)
      expect(run.mock.calls.map(([i]) => i.args[0])).toEqual(['locked', 'repl'])
    } finally { vi.useRealTimers() }
  })

  it('counts query time and rejects a release arriving after the monotonic deadline', async () => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(async i => {
      if (i.args[0] === 'repl') { h.advance(301); return 'false' }
      return base(i)
    })
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(dispatched(h.run)).toEqual([])
    expect(h.delay).not.toHaveBeenCalled()
  })

  it.each(['locked', 'repl', 'activewindow', 'dispatch'])('leaves the text copied on a %s failure', async command => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(i => i.args[0] === command ? Promise.reject(new Error('private')) : base(i))
    const clipboard = { writeText: vi.fn() }
    const output = new OutputService({
      clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() }, delay: vi.fn(),
      process: h.adapter, buildPasteInvocation: buildLinuxPasteInvocation,
    })
    await expect(output.deliver('safe copied result', { autoPaste: true, pasteDelayMs: 80 })).resolves.toBe('copied')
    expect(clipboard.writeText).toHaveBeenCalledWith('safe copied result')
    if (command !== 'dispatch') expect(dispatched(h.run)).toEqual([])
    else expect(dispatched(h.run)).toHaveLength(2) // Still attempt release after a lost down acknowledgement.
  })

  it.each([
    ['locked', '{"locked":true}'], ['locked', '{}'], ['repl', 'ok'],
    ['activewindow', 'not json'], ['dispatch', 'Invalid dispatcher'],
  ])('rejects unsuccessful %s replies even if hyprctl exits successfully', async (command, reply) => {
    const h = harness()
    const base = h.run.getMockImplementation()!
    h.run.mockImplementation(i => i.args[0] === command ? Promise.resolve(reply) : base(i))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    if (command !== 'dispatch') expect(dispatched(h.run)).toEqual([])
  })

  it('attempts key-up even if the inter-key delay fails', async () => {
    const h = harness(['terminal'])
    h.delay.mockRejectedValue(new Error('private'))
    await expect(h.adapter.run(buildLinuxPasteInvocation())).resolves.toBe(false)
    expect(dispatched(h.run).at(-1)).toEqual(buildHyprlandKeyInvocation({ mods: 'SHIFT', key: 'Insert' }, 'up'))
  })

  it('keeps the Windows and macOS invocations and warm-helper choices unchanged', () => {
    expect(createPasteCommands('win32').oneShot()).toEqual(buildWindowsPasteInvocation())
    expect(createPasteCommands('win32').helper).not.toBeNull()
    expect(createPasteCommands('darwin').oneShot()).toEqual(buildDarwinPasteInvocation())
    expect(createPasteCommands('darwin').helper).toBeNull()
    expect(createPasteCommands('linux').helper).toBeNull()
  })
})
