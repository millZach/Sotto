// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dictationSocketPath, parseDictationArguments, parseDictationCommand } from '../../../src/main/hotkeys/dictationCommand'

describe('compositor dictation commands', () => {
  it.each(['start', 'stop', 'toggle', 'cancel'])('accepts only dictation %s', command => {
    expect(parseDictationCommand(command)).toBe(command)
    expect(parseDictationArguments(['dictation', command])).toBe(command)
  })
  it.each([[], ['start'], ['dictation'], ['dictation', 'retry'], ['dictation', 'Start'], ['dictation', 'start', 'extra'], ['dictation', 'start\n'], ['other', 'stop']].map(args => ({ args })))('rejects malformed arguments $args', ({ args }) => {
    expect(parseDictationArguments(args)).toBeNull()
  })
  it('requires an absolute session runtime directory without a shared fallback', () => {
    expect(() => dictationSocketPath(undefined)).toThrow()
    expect(() => dictationSocketPath('relative')).toThrow()
    expect(dictationSocketPath('/run/user/1000')).toBe(join('/run/user/1000', 'sotto', 'dictation.sock'))
  })
})
