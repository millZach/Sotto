// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerQuitDrain } from '../../../src/main/app/quitDrain'
import { LinuxDictationShell } from '../../../src/main/hotkeys/linuxDictationShell'
import { DictationSocket } from '../../../src/main/hotkeys/dictationSocket'
import { ShellWidgetMonitor } from '../../../src/main/windows/shellWidgetMonitor'
import { DEFAULT_WIDGET_PALETTE } from '../../../src/shared/themeBranding'

describe.skipIf(process.platform !== 'linux')('Linux shell resource lifecycle', () => {
  let runtime: string
  let shell: LinuxDictationShell
  let exitSource: EventEmitter
  let statePath: string
  beforeEach(() => {
    runtime = mkdtempSync(join(tmpdir(), 'sotto-shell-'))
    statePath = join(runtime, 'sotto/dictation-state.json')
    exitSource = new EventEmitter()
    shell = new LinuxDictationShell(runtime,
      new ShellWidgetMonitor('linux', join(runtime, 'config'), runtime, vi.fn()),
      async () => true, () => 'top', vi.fn(), exitSource)
  })
  afterEach(() => { shell.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(runtime, { recursive: true, force: true }) })

  it('unlinks listening state on the forced quit timeout without runtime disposal', async () => {
    vi.useFakeTimers()
    await shell.start()
    await vi.advanceTimersByTimeAsync(50)
    shell.publish({ status: 'listening', sessionId: 's', startedAt: 1, level: 0,
      theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'F9', cancellable: true })
    expect(JSON.parse(readFileSync(statePath, 'utf8')).state).toBe('listening')
    const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn(() => exitSource.emit('exit')) })
    registerQuitDrain(app, () => new Promise<void>(() => undefined), vi.fn())
    app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(existsSync(statePath)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(app.exit).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()
    expect(existsSync(statePath)).toBe(false)
    expect(exitSource.listenerCount('exit')).toBe(0)
    shell.dispose()
    exitSource.emit('exit')
    await vi.advanceTimersByTimeAsync(100)
    expect(existsSync(statePath)).toBe(false)
  })

  it('removes the exit hook and state during ordinary disposal', async () => {
    await shell.start()
    expect(existsSync(statePath)).toBe(true)
    shell.dispose()
    shell.dispose()
    expect(existsSync(statePath)).toBe(false)
    expect(exitSource.listenerCount('exit')).toBe(0)
  })

  it('does not construct a publisher when socket startup finishes after disposal', async () => {
    let release!: () => void
    let ready!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const listening = new Promise<void>(resolve => { ready = resolve })
    const startSocket = DictationSocket.prototype.start
    const start = vi.spyOn(DictationSocket.prototype, 'start').mockImplementation(async function (this: DictationSocket) {
      await startSocket.call(this)
      ready()
      await held
    })
    const pending = shell.start()
    await listening
    expect(start).toHaveBeenCalledTimes(1)
    shell.dispose()
    release()
    await pending
    expect(existsSync(statePath)).toBe(false)
    expect(existsSync(join(runtime, 'sotto/dictation.sock'))).toBe(false)
    await shell.start()
    expect(start).toHaveBeenCalledTimes(1)
    expect(existsSync(statePath)).toBe(false)
    expect(exitSource.listenerCount('exit')).toBe(0)
  })
})
