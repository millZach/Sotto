// @vitest-environment node
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createWaylandClipboard, CLIPBOARD_PROCESS_TIMEOUT_MS } from '../../../src/main/output/waylandClipboard'
import { OutputClipboardError, OutputService } from '../../../src/main/output/outputService'
import { createPasteCommands } from '../../../src/main/output/pasteCommand'

function harness() {
  const child = new ChildProcess()
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

  it('kills a hung clipboard child and falls back at a finite deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const write = h.clipboard.writeText('kept text')
      await vi.advanceTimersByTimeAsync(CLIPBOARD_PROCESS_TIMEOUT_MS)
      await write
      expect(h.child.kill).toHaveBeenCalledOnce()
      expect(h.fallback.writeText).toHaveBeenCalledWith('kept text')
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

  it('never pastes the stale desktop selection after an Electron fallback', async () => {
    const h = harness()
    const run = vi.fn()
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay: vi.fn(), process: { run }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    const delivery = service.deliver('dictation', { autoPaste: true, pasteDelayMs: 80 })
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    h.child.emit('error', new Error('missing'))
    await expect(delivery).resolves.toBe('copied')
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps a failed fallback write in the existing completed-text recovery path', async () => {
    const h = harness()
    h.fallback.writeText.mockImplementation(() => { throw new Error('private') })
    const service = new OutputService({
      clipboard: h.clipboard, widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
      delay: vi.fn(), process: { run: vi.fn() }, buildPasteInvocation: createPasteCommands('linux').oneShot,
    })
    const delivery = service.deliver('dictation', { autoPaste: false, pasteDelayMs: 80 })
    const assertion = expect(delivery).rejects.toEqual(new OutputClipboardError())
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    h.child.emit('error', new Error('missing'))
    await assertion
  })
})
