// @vitest-environment node
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationStateFile, shellDictationFields } from '../../../src/main/hotkeys/dictationStateFile'
import { WIDGET_ERROR_CODES, type WidgetSnapshot } from '../../../src/shared/dictation'
import { DEFAULT_WIDGET_PALETTE } from '../../../src/shared/themeBranding'

const { renamed, written } = vi.hoisted(() => ({ renamed: vi.fn(), written: vi.fn() }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    renameSync: (from: string, to: string) => { renamed(from, to); fs.renameSync(from, to) },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { written(...args); fs.writeFileSync(...args) },
  }
})

function snapshot(fields: object): WidgetSnapshot {
  return { theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'F9', cancellable: true, sessionId: 's', ...fields } as WidgetSnapshot
}

describe('shell dictation copy', () => {
  const nothingRecorded = ['MIC_PERMISSION_DENIED', 'MIC_DEVICE_NOT_FOUND', 'MIC_START_FAILED', 'MIC_NOT_SET_UP', 'NO_SPEECH', 'SETTINGS_UNAVAILABLE'] as const
  const captured = ['RECORDING_FAILED', 'TRANSCRIPTION_UNCONFIGURED', 'TRANSCRIPTION_UNAUTHORIZED', 'TRANSCRIPTION_OFFLINE', 'TRANSCRIPTION_BILLING', 'TRANSCRIPTION_RATE_LIMITED', 'TRANSCRIPTION_SERVICE_ERROR', 'TRANSCRIPTION_FAILED', 'OUTPUT_UNAVAILABLE', 'OUTPUT_FAILED', 'DESKTOP_CLIPBOARD_UNAVAILABLE', 'HISTORY_FAILED'] as const

  it('puts every known failure in exactly one recording group', () => {
    const grouped = [...nothingRecorded, ...captured]
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped.slice().sort()).toEqual([...WIDGET_ERROR_CODES].sort())
  })

  it.each([...WIDGET_ERROR_CODES, 'UNKNOWN_ERROR'])('states the recording or text outcome for %s in fewer than 60 characters', code => {
    for (const kept of [false, true]) {
      const fields = shellDictationFields(snapshot({ status: 'error', code, kept, message: 'PRIVATE PROVIDER BODY' }))
      expect(fields).toMatchObject({ state: 'failed', kept })
      expect(fields.detail!.length).toBeLessThan(60)
      if (kept) expect(fields.detail).toContain('Recording kept.')
      else if ((nothingRecorded as readonly string[]).includes(code)) {
        expect(fields.detail).not.toMatch(/Recording (kept|lost)|was lost/)
        expect(fields.detail).toMatch(/try again|Dictate again|Settings/i)
      } else {
        expect(fields.detail).toMatch(/Recording lost\.|was lost\.|Text kept in Sotto\.|Text delivered and on the clipboard\./)
      }
      expect(fields.detail).not.toContain('PRIVATE')
    }
  })

  it.each(['OUTPUT_UNAVAILABLE', 'OUTPUT_FAILED', 'DESKTOP_CLIPBOARD_UNAVAILABLE'])('points %s to completed text in Dictate, independent of history', code => {
    expect(shellDictationFields(snapshot({ status: 'error', code, kept: false })).detail)
      .toBe('Text kept in Sotto. Open Dictate to copy it.')
  })

  it('says the text was delivered when only history saving failed', () => {
    expect(shellDictationFields(snapshot({ status: 'error', code: 'HISTORY_FAILED' })).detail)
      .toBe('Text delivered and on the clipboard. History not saved.')
  })

  it.each([false, true])('uses kept=%s for the unknown-code fallback', kept => {
    expect(shellDictationFields(snapshot({ status: 'error', code: 'UNKNOWN_ERROR', kept })).detail)
      .toBe(kept ? 'Dictation failed. Recording kept.' : 'Dictation failed. Recording lost. Dictate again.')
  })

  it('keeps the key and credit next steps and the copied instruction short', () => {
    for (const [code, nextStep] of [
      ['TRANSCRIPTION_UNCONFIGURED', 'Add it in Settings.'],
      ['TRANSCRIPTION_UNAUTHORIZED', 'Check Settings.'],
      ['TRANSCRIPTION_BILLING', 'Add credit.'],
    ]) {
      expect(shellDictationFields(snapshot({ status: 'error', code, kept: true })).detail).toContain(nextStep)
    }
    const copied = shellDictationFields(snapshot({ status: 'success', output: 'copied' }))
    expect(copied.detail).toBe('Copied — paste with Super+V')
    expect(copied.detail!.length).toBeLessThan(60)
  })

  it('names the rejected OpenRouter key and pins the kept-recording next step', () => {
    expect(shellDictationFields(snapshot({ status: 'error', code: 'TRANSCRIPTION_UNAUTHORIZED', kept: true })).detail)
      .toBe('OpenRouter key rejected. Recording kept. Check Settings.')
  })
})

describe.skipIf(process.platform !== 'linux')('private shell dictation state', () => {
  let runtime: string
  let file: DictationStateFile | undefined
  const failure = vi.fn()
  const read = () => JSON.parse(readFileSync(file!.path, 'utf8'))
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    renamed.mockReset(); written.mockReset(); failure.mockReset()
    runtime = mkdtempSync(join(tmpdir(), 'sotto-state-'))
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
  })
  afterEach(() => { file?.dispose(); file = undefined; vi.useRealTimers(); rmSync(runtime, { recursive: true, force: true }) })

  it.each([
    ['idle', {}, 'idle'], ['cancelled', {}, 'idle'], ['requesting-permission', {}, 'starting'],
    ['listening', { startedAt: 1, level: 1 }, 'listening'], ['processing', { stage: 'transcribing', progress: 0.5, startedAt: 1 }, 'transcribing'],
    ['success', { output: 'pasted' }, 'delivered'], ['success', { output: 'copied' }, 'copied'],
    ['error', { code: 'TRANSCRIPTION_RATE_LIMITED', kept: true }, 'failed'],
  ])('maps %s to %s without taking extra text', (status, extra, state) => {
    const fields = shellDictationFields(snapshot({ status, ...extra, text: 'PRIVATE TRANSCRIPT', message: 'PRIVATE PROVIDER BODY' }))
    expect(fields.state).toBe(state)
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE/)
    expect(fields.kept).toBe(status === 'error')
  })
  it('replaces complete JSON atomically in the validated folder with mode 0600', () => {
    file = new DictationStateFile(runtime, 'top', failure)
    expect(read()).toEqual({ version: 1, pid: process.pid, state: 'idle', since: 1000, updatedAt: 1000, detail: null, kept: false, edge: 'top' })
    const original = lstatSync(file.path)
    vi.advanceTimersByTime(50)
    renamed.mockImplementation((temp, target) => {
      expect(target).toBe(file!.path)
      expect(temp).toMatch(/\/sotto\/dictation-state.json\..*\.tmp$/)
      expect(JSON.parse(readFileSync(temp, 'utf8'))).toMatchObject({ version: 1, pid: process.pid, state: 'listening' })
      expect(lstatSync(temp).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ version: 1, pid: process.pid, state: 'idle' })
    })
    file.publish(snapshot({ status: 'listening', level: 1, startedAt: 1 }))
    expect(lstatSync(file.path).ino).not.toBe(original.ino)
    expect(lstatSync(file.path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(runtime, 'sotto'))).toEqual(['dictation-state.json'])
    expect(failure).not.toHaveBeenCalled()
  })
  it('keeps the final state in a burst and ignores level/progress without resetting since', () => {
    file = new DictationStateFile(runtime, 'top', failure)
    vi.advanceTimersByTime(50)
    file.publish(snapshot({ status: 'listening', level: 0, startedAt: 1 }))
    const since = read().since
    for (let level = 0; level < 100; level++) file.publish(snapshot({ status: 'listening', level, startedAt: 1 }))
    expect(renamed).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10)
    file.publish(snapshot({ status: 'processing', stage: 'transcribing', progress: 0, startedAt: 1 }))
    file.publish(snapshot({ status: 'success', output: 'copied', pid: -1, text: 'PRIVATE TRANSCRIPT' }))
    expect(read().state).toBe('listening')
    vi.advanceTimersByTime(40)
    expect(read()).toMatchObject({ version: 1, pid: process.pid, state: 'copied', since: since + 10, updatedAt: since + 10, detail: 'Copied — paste with Super+V' })
    expect(renamed).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(100)
    expect(renamed).toHaveBeenCalledTimes(3)
  })
  it('writes only reviewed failure copy and kept status for every controller error', () => {
    file = new DictationStateFile(runtime, 'left', failure)
    for (const code of WIDGET_ERROR_CODES) {
      file.publish(snapshot({ status: 'error', code, kept: true, text: 'PRIVATE TRANSCRIPT', message: 'PRIVATE PROVIDER BODY' }))
      vi.advanceTimersByTime(50)
      expect(read()).toMatchObject({ state: 'failed', kept: true, edge: 'left' })
      expect(read().detail).toContain('Recording kept.')
      expect(read().detail.length).toBeLessThan(60)
    }
    file.publish(snapshot({ status: 'error', code: 'PRIVATE TRANSCRIPT', message: 'PRIVATE PROVIDER BODY' }))
    vi.advanceTimersByTime(50)
    expect(read().kept).toBe(false)
    for (const [, data] of written.mock.calls) {
      expect(data).not.toMatch(/PRIVATE/)
      expect(JSON.parse(data)).toMatchObject({ version: 1, pid: process.pid })
    }
  })
  it('publishes an edge change without changing the state start and removes pending state at quit', () => {
    file = new DictationStateFile(runtime, 'top', failure)
    vi.advanceTimersByTime(50)
    file.place('right')
    expect(read()).toMatchObject({ version: 1, pid: process.pid, state: 'idle', edge: 'right', since: 1000, updatedAt: 1050 })
    file.publish(snapshot({ status: 'error', code: 'TRANSCRIPTION_FAILED', kept: true }))
    file.dispose()
    vi.advanceTimersByTime(100)
    expect(existsSync(file.path)).toBe(false)
    file.publish(snapshot({ status: 'idle' }))
    expect(existsSync(file.path)).toBe(false)
  })
  it('refuses unsafe folders and stops writing if a validated folder is replaced', () => {
    chmodSync(join(runtime, 'sotto'), 0o755)
    expect(() => new DictationStateFile(runtime, 'top', failure)).toThrow()
    chmodSync(join(runtime, 'sotto'), 0o700)
    file = new DictationStateFile(runtime, 'top', failure)
    vi.advanceTimersByTime(50)
    renameSync(join(runtime, 'sotto'), join(runtime, 'old'))
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    file.place('bottom')
    expect(failure).toHaveBeenCalledOnce()
    expect(readdirSync(join(runtime, 'sotto'))).toEqual([])
    rmSync(join(runtime, 'sotto'), { recursive: true })
    symlinkSync(join(runtime, 'old'), join(runtime, 'sotto'))
    expect(() => new DictationStateFile(runtime, 'top', failure)).toThrow()
  })
})
