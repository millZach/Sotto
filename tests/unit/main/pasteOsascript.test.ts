// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PASTE_PROCESS_TIMEOUT_MS } from '../../../src/main/output/outputService'
import { buildDarwinPasteInvocation } from '../../../src/main/output/pasteCommand.darwin'
import {
  DARWIN_PASTE_PROCESS_TIMEOUT_MS,
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

  it('waits through a first Automation prompt longer than the Windows paste would', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())

    await vi.advanceTimersByTimeAsync(PASTE_PROCESS_TIMEOUT_MS * 2)
    expect(h.kill).not.toHaveBeenCalled()
    h.close(0)

    await expect(result).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills osascript and leaves the text copied when the prompt is never answered', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.adapter.run(buildDarwinPasteInvocation())

    await vi.advanceTimersByTimeAsync(DARWIN_PASTE_PROCESS_TIMEOUT_MS)
    expect(h.kill).toHaveBeenCalledTimes(1)
    await expect(result).resolves.toBe(false)
    expect(h.log).toHaveBeenCalledExactlyOnceWith('paste-osascript-timeout')

    h.close(0)
    expect(h.onDenied).not.toHaveBeenCalled()
  })
})
