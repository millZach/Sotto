// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerQuitDrain } from '../../../src/main/app/quitDrain'
import { NativeRuntimeController } from '../../../src/main/app/bootstrap'
import { LinuxDictationShell } from '../../../src/main/hotkeys/linuxDictationShell'
import { DictationSocket } from '../../../src/main/hotkeys/dictationSocket'
import { ShellWidgetMonitor } from '../../../src/main/windows/shellWidgetMonitor'
import { DEFAULT_WIDGET_PALETTE } from '../../../src/shared/themeBranding'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

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
      new ShellWidgetMonitor('linux', runtime, vi.fn()),
      async () => true, () => 'top', vi.fn(), exitSource)
  })
  afterEach(() => { shell.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(runtime, { recursive: true, force: true }) })

  it.each([undefined, 'relative-runtime'])('opens Sotto without commands or shell state when the runtime path is %s', async runtimeDirectory => {
    shell.dispose()
    const dispatch = vi.fn(async () => true)
    const stateFailure = vi.fn()
    shell = new LinuxDictationShell(runtimeDirectory,
      new ShellWidgetMonitor('linux', runtime, vi.fn()),
      dispatch, () => 'top', stateFailure, exitSource)
    const windows = { createWindows: vi.fn(async () => undefined), showMain: vi.fn(async () => undefined),
      showWidget: vi.fn(async () => undefined), beginQuit: vi.fn(), dispose: vi.fn() }
    const log = vi.fn()
    const controller = new NativeRuntimeController({
      windows, dictationCommands: shell, log,
      settings: { get: async () => ({ ...DEFAULT_SETTINGS, startMinimized: false }) },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      startup: { set: vi.fn() }, tray: { update: vi.fn(), dispose: vi.fn() },
      installPermissions: () => vi.fn(), registerIpc: () => vi.fn(),
    })
    const startSocket = vi.spyOn(DictationSocket.prototype, 'start')
    await expect(controller.start()).resolves.toBeUndefined()
    expect(windows.createWindows).toHaveBeenCalledOnce()
    expect(windows.showMain).toHaveBeenCalledOnce()
    expect(log.mock.calls).toEqual([['native-dictation-command-start-failed']])
    expect(startSocket).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    shell.publish({ status: 'idle', theme: 'system', palette: DEFAULT_WIDGET_PALETTE,
      reducedMotion: 'system', shortcut: 'F9', cancellable: false })
    expect(existsSync(statePath)).toBe(false)
    expect(stateFailure).not.toHaveBeenCalled()
    controller.dispose()
    await shell.start()
    expect(startSocket).not.toHaveBeenCalled()
    expect(exitSource.listenerCount('exit')).toBe(0)
  })

  it('unlinks listening state on the forced quit timeout without runtime disposal', async () => {
    const disposeMonitor = vi.spyOn(ShellWidgetMonitor.prototype, 'dispose')
    const disposeSocket = vi.spyOn(DictationSocket.prototype, 'dispose')
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
    expect(disposeMonitor).not.toHaveBeenCalled()
    expect(disposeSocket).not.toHaveBeenCalled()
    shell.dispose()
    expect(disposeMonitor).toHaveBeenCalledOnce()
    expect(disposeSocket).toHaveBeenCalledOnce()
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
