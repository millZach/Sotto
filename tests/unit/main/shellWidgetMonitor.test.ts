// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellWidgetMonitor } from '../../../src/main/windows/shellWidgetMonitor'

describe('shell plugin folder monitor', () => {
  let home: string
  let monitor: ShellWidgetMonitor | undefined
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sotto-shell-')) })
  afterEach(() => { monitor?.dispose(); monitor = undefined; rmSync(home, { recursive: true, force: true }) })
  it('watches installation, removal and reinstall even when config parents did not exist', async () => {
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor('linux', join(home, 'config'), home, changed)
    monitor.start()
    expect(changed).toHaveBeenLastCalledWith(false)
    mkdirSync(monitor.path, { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true))
    rmSync(join(home, 'config'), { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false), { timeout: 3000 })
    mkdirSync(monitor.path, { recursive: true })
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true))
    expect(changed.mock.calls).toEqual([[false], [true], [false], [true]])
  })
  it('finds an already-installed plugin at the HOME fallback', () => {
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor('linux', undefined, home, changed)
    expect(monitor.path).toBe(join(home, '.config/omarchy/plugins/sotto.dictation'))
    mkdirSync(monitor.path, { recursive: true })
    monitor.start()
    expect(changed).toHaveBeenCalledExactlyOnceWith(true)
  })
  it.each(['win32', 'darwin'] as const)('does not watch or suppress the widget on %s', platform => {
    const changed = vi.fn()
    monitor = new ShellWidgetMonitor(platform, undefined, home, changed)
    mkdirSync(monitor.path, { recursive: true })
    monitor.start()
    expect(changed).not.toHaveBeenCalled()
  })
})
