// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dictationSocketPath, parseDictationArguments, parseDictationCommand } from '../../../src/main/hotkeys/dictationCommand'

describe('compositor dictation commands', () => {
  it.each(['start', 'stop', 'toggle', 'cancel', 'retry', 'discard'])('accepts only dictation %s', command => {
    expect(parseDictationCommand(command)).toBe(command)
    expect(parseDictationArguments(['dictation', command])).toEqual({ command })
  })
  it.each(['start', 'stop', 'toggle', 'cancel', 'retry', 'discard'])('passes the event stamp for %s without losing nanosecond precision', command => {
    expect(parseDictationArguments(['dictation', command, '--at', '1791486000123456789'])).toEqual({ command, at: 1791486000123456789n })
  })
  it.each(['', '0', '-1', '+1', '1.5', '1e18', '123\n', ' 123', '123 ', '1'.repeat(21)])('rejects malformed stamp %j', at => {
    expect(parseDictationArguments(['dictation', 'start', '--at', at])).toBeNull()
  })
  it.each([[], ['start'], ['dictation'], ['dictation', 'unknown'], ['dictation', 'place left'], ['dictation', 'Start'], ['dictation', 'start', 'extra'], ['dictation', 'start\n'], ['other', 'stop']].map(args => ({ args })))('rejects malformed arguments $args', ({ args }) => {
    expect(parseDictationArguments(args)).toBeNull()
  })
  it.each(['top', 'bottom', 'left', 'right'])('accepts place %s with a stamp within the unchanged limit', edge => {
    expect(parseDictationArguments(['dictation', 'place', edge])).toEqual({ command: `place ${edge}` })
    expect(parseDictationArguments(['dictation', 'place', edge, '--at', '1791486000123456789'])).toEqual({ command: `place ${edge}`, at: 1791486000123456789n })
    expect(Buffer.byteLength(`place ${edge} --at ${'1'.repeat(20)}\n`)).toBeLessThanOrEqual(40)
  })
  it.each(['', 'Top', '../left', 'left\n', 'left;id', 'centre', 'left right'])('refuses unsafe or unknown edge %j', edge => {
    expect(parseDictationArguments(['dictation', 'place', edge])).toBeNull()
  })
  it('requires an absolute session runtime directory without a shared fallback', () => {
    expect(() => dictationSocketPath(undefined)).toThrow()
    expect(() => dictationSocketPath('relative')).toThrow()
    expect(dictationSocketPath('/run/user/1000')).toBe(join('/run/user/1000', 'sotto', 'dictation.sock'))
  })
})
