// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDarwinPasteInvocation } from '../../../src/main/output/pasteCommand.darwin'
import { OutputService, PASTE_PROCESS_TIMEOUT_MS, PASTE_SETTLE_MS } from '../../../src/main/output/outputService'
import {
  classifyOsascriptFailure,
  createOsascriptPasteAdapter,
  type OsascriptChildLike,
} from '../../../src/main/output/pasteOsascript'

function fakeChild() {
  const listeners = new Map<string, (...args: never[]) => void>()
  let stderrListener: ((chunk: unknown) => void) | undefined
  const kill = vi.fn(() => true)
  const child: OsascriptChildLike = {
    stderr: { on: (_event, listener) => { stderrListener = listener } },
    once(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener)
      return this
    },
    kill,
  }
  return {
    child,
    kill,
    writeStderr: (text: string) => stderrListener?.(Buffer.from(text)),
    close: (code: number | null, signal: string | null = null) =>
      listeners.get('close')?.(code as never, signal as never),
    error: () => listeners.get('error')?.(new Error('private') as never),
  }
}

function harness() {
  const fake = fakeChild()
  const spawn = vi.fn(() => fake.child)
  const onDenied = vi.fn()
  const log = vi.fn()
  const adapter = createOsascriptPasteAdapter({ spawn, onDenied, log })
  return { ...fake, spawn, onDenied, log, adapter }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('classifyOsascriptFailure', () => {
  it.each([
    ['36:83: execution error: Not authorized to send Apple events to System Events. (-1743)', 'automation'],
    ['execution error: Not authorised to send Apple events to System Events.', 'automation'],
    ['execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)', 'accessibility'],
    ['execution error: System Events got an error: osascript is not allowed assistive access. (-25211)', 'accessibility'],
    ['execution error: System Events got an error: (-1719)', 'accessibility'],
    ['execution error: Some other problem. (-600)', null],
    ['', null],
  ] as const)('reads %j as %s', (stderr, expected) => {
    expect(classifyOsascriptFailure(stderr)).toBe(expected)
  })
})

describe('createOsascriptPasteAdapter', () => {
  it('spawns osascript without a shell and with only stderr piped', async () => {
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.close(0)

    await expect(result).resolves.toBe(true)
    expect(h.spawn).toHaveBeenCalledWith('/usr/bin/osascript', buildDarwinPasteInvocation().args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    expect(h.onDenied).not.toHaveBeenCalled()
    expect(h.log).not.toHaveBeenCalled()
  })

  it('reports a denied Automation permission with a stable event name only', async () => {
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.writeStderr('execution error: Not authorized to send Apple events to System Events. (-1743)\n')
    h.close(1)

    await expect(result).resolves.toBe(false)
    expect(h.onDenied).toHaveBeenCalledExactlyOnceWith('automation')
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-automation-denied')
  })

  it('reports a denied Accessibility permission', async () => {
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.writeStderr('System Events got an error: osascript is not allowed to send keystrokes. (1002)')
    h.close(1)

    await expect(result).resolves.toBe(false)
    expect(h.onDenied).toHaveBeenCalledExactlyOnceWith('accessibility')
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-accessibility-denied')
  })

  it('treats any other failure as copied without naming a permission', async () => {
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.writeStderr('private detail that must not reach the log')
    h.close(1)

    await expect(result).resolves.toBe(false)
    expect(h.onDenied).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-osascript-failed')
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('private')
  })

  it('treats a spawn error as copied', async () => {
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.error()

    await expect(result).resolves.toBe(false)
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-osascript-failed')
  })

  it('keeps a copied outcome when the notice or the log throws', async () => {
    const h = harness()
    h.onDenied.mockImplementation(() => { throw new Error('publish failed') })
    h.log.mockImplementation(() => { throw new Error('log failed') })
    const result = h.adapter.run(buildDarwinPasteInvocation())
    h.writeStderr('(-1743)')
    h.close(1)

    await expect(result).resolves.toBe(false)
  })

  it('gives up on an unanswered Automation prompt on the usual paste deadline', async () => {
    vi.useFakeTimers()
    const h = harness()
    let resolved: boolean | undefined
    void Promise.resolve(h.adapter.run(buildDarwinPasteInvocation())).then((value) => { resolved = value })

    await vi.advanceTimersByTimeAsync(PASTE_PROCESS_TIMEOUT_MS - 1)
    expect(resolved).toBeUndefined()
    expect(h.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(false)
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-osascript-timeout')
    expect(h.onDenied).toHaveBeenCalledExactlyOnceWith('automation')

    // The killed child closing afterwards changes nothing.
    h.close(null, 'SIGTERM')
    expect(h.onDenied).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a timed-out paste copied, restores the widget and lets the next delivery through', async () => {
    vi.useFakeTimers()
    const h = harness()
    const clipboard: string[] = []
    const widget = { hideWidget: vi.fn(), showWidget: vi.fn() }
    const output = new OutputService({
      clipboard: { writeText: (text) => { clipboard.push(text) } },
      widget,
      delay: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) }),
      process: h.adapter,
      buildPasteInvocation: buildDarwinPasteInvocation,
    })
    const settled: string[] = []
    void output.deliver('first', { autoPaste: true, pasteDelayMs: 0, restoreWidget: true })
      .then((outcome) => { settled.push(`first:${outcome}`) })
    void output.deliver('second', { autoPaste: false, pasteDelayMs: 0 })
      .then((outcome) => { settled.push(`second:${outcome}`) })

    await vi.advanceTimersByTimeAsync(PASTE_PROCESS_TIMEOUT_MS + PASTE_SETTLE_MS)

    expect(settled).toEqual(['first:copied', 'second:copied'])
    expect(clipboard).toEqual(['first', 'second'])
    expect(widget.showWidget).toHaveBeenCalledTimes(1)
    expect(h.onDenied).toHaveBeenCalledExactlyOnceWith('automation')
    expect(vi.getTimerCount()).toBe(0)
  })
})
