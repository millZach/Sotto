// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellWidgetMonitor } from '../../../src/main/windows/shellWidgetMonitor'

const { watched } = vi.hoisted(() => ({ watched: vi.fn() }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, watch: (...args: Parameters<typeof fs.watch>) => { watched(...args); return fs.watch(...args) } }
})

describe('shell plugin folder monitor', () => {
  let home: string
  let monitor: ShellWidgetMonitor | undefined
  beforeEach(() => { watched.mockClear(); home = mkdtempSync(join(tmpdir(), 'sotto-shell-')) })
  afterEach(() => { monitor?.dispose(); monitor = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
  it('keeps its watcher through periodic refreshes until the nearest parent changes', () => {
    vi.useFakeTimers()
    monitor = new ShellWidgetMonitor('linux', home, vi.fn())
    monitor.start()
    vi.advanceTimersByTime(3_000)
    expect(watched).toHaveBeenCalledTimes(1)
    mkdirSync(monitor.path, { recursive: true })
    vi.advanceTimersByTime(1_000)
    expect(watched).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3_000)
    expect(watched).toHaveBeenCalledTimes(2)
    rmSync(join(home, '.config'), { recursive: true })
    vi.advanceTimersByTime(1_000)
    expect(watched).toHaveBeenCalledTimes(3)
  })
  it('watches installation, removal and reinstall even when config parents did not exist', async () => {
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor('linux', home, changed)
    monitor.setStateFileLive(true)
    monitor.start()
    expect(changed).toHaveBeenLastCalledWith(false)
    mkdirSync(monitor.path, { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true))
    rmSync(join(home, '.config'), { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false), { timeout: 3000 })
    mkdirSync(monitor.path, { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true))
    expect(changed.mock.calls).toEqual([[false], [true], [false], [true]])
  })
  it('ignores XDG_CONFIG_HOME and watches only the plugin under HOME/.config', () => {
    vi.useFakeTimers()
    const config = join(home, 'elsewhere')
    vi.stubEnv('XDG_CONFIG_HOME', config)
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor('linux', home, changed)
    monitor.setStateFileLive(true)
    expect(monitor.path).toBe(join(home, '.config/omarchy/plugins/sotto.dictation'))
    mkdirSync(join(config, 'omarchy/plugins/sotto.dictation'), { recursive: true })
    monitor.start()
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    expect(watched).toHaveBeenNthCalledWith(1, home, expect.any(Function))
    mkdirSync(monitor.path, { recursive: true })
    vi.advanceTimersByTime(1_000)
    expect(changed).toHaveBeenLastCalledWith(true)
    expect(watched).toHaveBeenNthCalledWith(2, join(home, '.config/omarchy/plugins'), expect.any(Function))
    rmSync(monitor.path, { recursive: true })
    vi.advanceTimersByTime(1_000)
    expect(changed.mock.calls).toEqual([[false], [true], [false]])
  })
  it('finds an already-installed plugin under HOME/.config without XDG_CONFIG_HOME', () => {
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor('linux', home, changed)
    monitor.setStateFileLive(true)
    expect(monitor.path).toBe(join(home, '.config/omarchy/plugins/sotto.dictation'))
    mkdirSync(monitor.path, { recursive: true })
    monitor.start()
    expect(changed).toHaveBeenCalledExactlyOnceWith(true)
  })
  it.each(['win32', 'darwin'] as const)('does not watch or suppress the widget on %s', platform => {
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor(platform, home, changed)
    mkdirSync(monitor.path, { recursive: true })
    monitor.setStateFileLive(true)
    monitor.start()
    monitor.setStateFileLive(false)
    monitor.dispose()
    expect(changed).not.toHaveBeenCalled()
  })
})
