// @vitest-environment node
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createWaylandClipboard, CLIPBOARD_PROCESS_TIMEOUT_MS, CLIPBOARD_TERMINATE_GRACE_MS } from '../../../src/main/output/waylandClipboard'
import { OutputService, OutputClipboardError } from '../../../src/main/output/outputService'
import { createPasteCommands } from '../../../src/main/output/pasteCommand'

function harness() {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: 12345 })
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = vi.fn(() => true)
  const spawn = vi.fn(() => child)
  const fallback = { writeText: vi.fn(), readText: vi.fn(() => 'previous clipboard') }
  const notice = vi.fn()
  return { child, spawn, fallback, notice, clipboard: createWaylandClipboard(fallback, notice, spawn) }
}

describe('Wayland clipboard', () => {
  it('writes exact UTF-8 text on stdin with argument arrays and no shell or stdout pipe', async () => {
    const h = harness()
    const transcript = '  café\n"$(touch should-not-exist)"; `echo no` 🚀\n'
    let input = ''
    h.child.stdin!.on('data', chunk => { input += chunk.toString() })
    const write = h.clipboard.writeText(transcript)
    expect(h.spawn).toHaveBeenCalledWith('wl-copy', ['--type', 'text/plain;charset=utf-8'], {
      shell: false, stdio: ['pipe', 'ignore', 'ignore'],
    })
    expect(input).toBe(transcript)
    expect(h.child.stdin!.writableEnded).toBe(true)
    h.child.emit('close', 0, null)
    await write
    expect(h.clipboard.canPaste!()).toBe(true)
    expect(h.fallback.writeText).not.toHaveBeenCalled()
    expect(h.notice).not.toHaveBeenCalled()
  })

  it('reads the desktop clipboard with wl-paste without adding or dropping a newline', async () => {
    const h = harness()
    const read = h.clipboard.readText()
    expect(h.spawn).toHaveBeenCalledWith('wl-paste', ['--no-newline'], {
      shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    })
    h.child.stdout!.emit('data', 'original\n')
    h.child.stdout!.emit('data', 'clipboard\n')
    h.child.emit('close', 0, null)
    await expect(read).resolves.toBe('original\nclipboard\n')
  })

  it.each(['write', 'read'] as const)('uses Electron and a plain notice when %s cannot find wl-clipboard', async operation => {
    const h = harness()
    const result = operation === 'write' ? h.clipboard.writeText('copied text') : h.clipboard.readText()
    h.child.emit('error', Object.assign(new Error('private OS detail'), { code: 'ENOENT' }))
    await result
    expect(h.notice).toHaveBeenCalledOnce()
    expect(h.clipboard.canPaste!()).toBe(false)
    if (operation === 'write') expect(h.fallback.writeText).toHaveBeenCalledWith('copied text')
    else expect(h.fallback.readText).toHaveBeenCalledOnce()
  })

  it('does not repost the fallback notice on repeated copy clicks and retries after recovery', async () => {
    const h = harness()
    h.spawn.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay: vi.fn(), process: { run: vi.fn() }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    // Copy text, History, thread actions, host setup and sign-in all request copy-only output.
    for (const text of ['Copy text', 'History copy', 'agent copy', 'host setup', 'sign-in']) {
      await expect(service.deliver(text, { autoPaste: false, pasteDelayMs: 0 })).resolves.toBe('copied')
      expect(h.fallback.writeText).toHaveBeenLastCalledWith(text)
    }
    expect(h.notice).toHaveBeenCalledOnce()
    h.spawn.mockImplementationOnce(() => h.child)
    const recovered = h.clipboard.writeText('recovered')
    h.child.emit('close', 0, null)
    await recovered
    await h.clipboard.writeText('missing again')
    expect(h.notice).toHaveBeenCalledTimes(2)
  })

  it.each(['throw', 'exit', 'signal', 'stdin'] as const)('falls back on %s without leaking OS details', async failure => {
    const h = harness()
    if (failure === 'throw') h.spawn.mockImplementation(() => { throw new Error('private') })
    const write = h.clipboard.writeText('kept text')
    if (failure === 'exit') h.child.emit('close', 1, null)
    if (failure === 'signal') h.child.emit('close', null, 'SIGTERM')
    if (failure === 'stdin') h.child.stdin!.emit('error', new Error('EPIPE'))
    await write
    expect(h.fallback.writeText).toHaveBeenCalledWith('kept text')
    expect(h.notice).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'stdin'] as const)('terminates and escalates a still-running clipboard child after %s', async failure => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const write = h.clipboard.writeText('kept text')
      if (failure === 'stdin') h.child.stdin!.emit('error', new Error('EPIPE'))
      else await vi.advanceTimersByTimeAsync(CLIPBOARD_PROCESS_TIMEOUT_MS)
      await write
      expect(vi.mocked(h.child.kill).mock.calls).toEqual([['SIGTERM']])
      expect(h.fallback.writeText).toHaveBeenCalledWith('kept text')
      await vi.advanceTimersByTimeAsync(CLIPBOARD_TERMINATE_GRACE_MS)
      expect(vi.mocked(h.child.kill).mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('cancels escalation when the failed clipboard child exits after SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const write = h.clipboard.writeText('kept text')
      h.child.stdin!.emit('error', new Error('EPIPE'))
      await write
      h.child.emit('exit', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(CLIPBOARD_PROCESS_TIMEOUT_MS)
      expect(vi.mocked(h.child.kill).mock.calls).toEqual([['SIGTERM']])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('awaits the desktop write before the paste delay and keeps the transcript afterwards', async () => {
    const h = harness()
    const delay = vi.fn()
    const paste = vi.fn(() => true)
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay, process: { run: paste }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    const delivery = service.deliver('dictation', { autoPaste: true, pasteDelayMs: 80 })
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    expect(delay).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    h.child.emit('close', 0, null)
    await expect(delivery).resolves.toBe('pasted')
    expect(delay.mock.calls).toEqual([[80], [150]])
    expect(h.spawn).toHaveBeenCalledOnce() // Windows does not restore; Linux also leaves the text copied.
  })

  it.each([false, true])('reports copied for copy-only and unavailable for automatic paste after Electron fallback with autoPaste=%s', async autoPaste => {
    const h = harness()
    const run = vi.fn()
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay: vi.fn(), process: { run }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    const delivery = service.deliver('dictation', { autoPaste, pasteDelayMs: 80 })
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    h.child.emit('error', new Error('missing'))
    await expect(delivery).resolves.toBe(autoPaste ? 'clipboard-unavailable' : 'copied')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([false, true])('reports desktop unavailability when Electron fallback also fails with autoPaste=%s', async autoPaste => {
    const h = harness()
    h.fallback.writeText.mockImplementation(() => { throw new Error('private') })
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay: vi.fn(), process: { run: vi.fn() }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    const delivery = service.deliver('dictation', { autoPaste, pasteDelayMs: 80 })
    const assertion = autoPaste ? expect(delivery).resolves.toBe('clipboard-unavailable')
      : expect(delivery).rejects.toBeInstanceOf(OutputClipboardError)
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    h.child.emit('error', new Error('missing'))
    await assertion
  })
})
