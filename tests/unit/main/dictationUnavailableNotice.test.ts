// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyDictationUnavailable } from '../../../src/main/hotkeys/dictationUnavailableNotice'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: exec }))

describe.skipIf(process.platform !== 'linux')('closed-app desktop notification', () => {
  let runtime: string
  let stamp: string
  beforeEach(() => {
    runtime = mkdtempSync(join(tmpdir(), 'sotto-notice-'))
    stamp = join(runtime, 'sotto-dictation-notice')
    vi.stubEnv('XDG_RUNTIME_DIR', runtime)
  })
  afterEach(() => {
    rmSync(runtime, { recursive: true, force: true })
    exec.mockReset()
    vi.unstubAllEnvs()
  })

  it.each([
    ['start', 'Open Sotto, then press F9 again.'], ['toggle', 'Open Sotto, then try again.'],
  ] as const)('uses fixed Sotto copy, name and icon for %s, without a shell', (command, body) => {
    notifyDictationUnavailable(command)
    expect(exec).toHaveBeenCalledExactlyOnceWith('notify-send', [
      '--app-name', 'Sotto', '--icon', 'sotto', '--expire-time', '5000', "Sotto isn't open.", body,
    ], { shell: false, timeout: 1_000 }, expect.any(Function))
    expect(readFileSync(stamp, 'utf8')).toBe('')
    expect(readdirSync(runtime)).toEqual(['sotto-dictation-notice'])
  })
  it.each(['stop', 'cancel', 'retry', 'discard', 'place top'] as const)('keeps %s quiet without claiming the cooldown', command => {
    notifyDictationUnavailable(command)
    expect(exec).not.toHaveBeenCalled()
    expect(readdirSync(runtime)).toEqual([])
  })
  it('shares a five-second cooldown across key presses and client calls', () => {
    notifyDictationUnavailable('start')
    notifyDictationUnavailable('toggle')
    notifyDictationUnavailable('start')
    expect(exec).toHaveBeenCalledTimes(1)
    const past = new Date(Date.now() - 5_001)
    utimesSync(stamp, past, past)
    notifyDictationUnavailable('toggle')
    expect(exec).toHaveBeenCalledTimes(2)
  })
  it('suppresses another client while the stamp is being claimed', () => {
    mkdirSync(`${stamp}.lock`)
    notifyDictationUnavailable('start')
    expect(exec).not.toHaveBeenCalled()
  })
  it('leaves a linked stamp and its target intact', () => {
    const target = join(runtime, 'keep')
    writeFileSync(target, 'keep')
    symlinkSync(target, stamp)
    notifyDictationUnavailable('start')
    expect(exec).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
  it('does nothing without a safe desktop runtime', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '')
    notifyDictationUnavailable('start')
    expect(exec).not.toHaveBeenCalled()
  })
  it.each(['spawn', 'callback'])('does not throw when notify-send fails at %s', failure => {
    exec.mockImplementation((_program, _args, _options, callback) => {
      if (failure === 'spawn') throw new Error('Unavailable')
      callback(new Error('Unavailable'))
    })
    expect(() => notifyDictationUnavailable('start')).not.toThrow()
    expect(readdirSync(runtime)).toEqual(['sotto-dictation-notice'])
  })
})
