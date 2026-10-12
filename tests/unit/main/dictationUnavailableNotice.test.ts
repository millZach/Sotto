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
  ] as const)('uses fixed Sotto copy, name and icon for %s, without a shell', async (command, body) => {
    await notifyDictationUnavailable(command)
    expect(exec).toHaveBeenCalledExactlyOnceWith('notify-send', [
      '--app-name', 'Sotto', '--app-icon', 'sotto', '--icon', 'sotto', '--expire-time', '5000', "Sotto isn't open.", body,
    ], { shell: false, timeout: 1_000 }, expect.any(Function))
    expect(readFileSync(stamp, 'utf8')).toBe('')
    expect(readdirSync(runtime)).toEqual(['sotto-dictation-notice'])
  })
  it.each(['stop', 'cancel', 'retry', 'discard', 'place top'] as const)('keeps %s quiet without claiming the cooldown', async command => {
    await notifyDictationUnavailable(command)
    expect(exec).not.toHaveBeenCalled()
    expect(readdirSync(runtime)).toEqual([])
  })
  it('shares a five-second cooldown across key presses and client calls', async () => {
    await notifyDictationUnavailable('start')
    await notifyDictationUnavailable('toggle')
    await notifyDictationUnavailable('start')
    expect(exec).toHaveBeenCalledTimes(1)
    const past = new Date(Date.now() - 5_001)
    utimesSync(stamp, past, past)
    await notifyDictationUnavailable('toggle')
    expect(exec).toHaveBeenCalledTimes(2)
  })
  it('ignores an abandoned directory lock from an older client', async () => {
    mkdirSync(`${stamp}.lock`)
    await notifyDictationUnavailable('start')
    expect(exec).toHaveBeenCalledOnce()
    expect(readdirSync(runtime)).toContain('sotto-dictation-notice.lock')
  })
  it('leaves a linked stamp and its target intact', async () => {
    const target = join(runtime, 'keep')
    writeFileSync(target, 'keep')
    symlinkSync(target, stamp)
    await notifyDictationUnavailable('start')
    expect(exec).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
  it('does nothing without a safe desktop runtime', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '')
    await notifyDictationUnavailable('start')
    expect(exec).not.toHaveBeenCalled()
  })
  it.each(['spawn', 'callback'])('does not throw when notify-send fails at %s', async failure => {
    exec.mockImplementation((_program, _args, _options, callback) => {
      if (failure === 'spawn') throw new Error('Unavailable')
      callback(new Error('Unavailable'))
    })
    await expect(notifyDictationUnavailable('start')).resolves.toBeUndefined()
    expect(readdirSync(runtime)).toEqual(['sotto-dictation-notice'])
  })
})
