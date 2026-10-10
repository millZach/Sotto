// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLinuxProcessStart, readLinuxProcessStart } from '../../../src/main/hotkeys/linuxProcessStart'

const { readStat } = vi.hoisted(() => ({ readStat: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: readStat }))

// Fields 3 through 21 precede starttime; later fields must not be mistaken for it.
const stat = (start: string) => `123 (sotto (shell) worker)) S ${Array(18).fill('0').join(' ')} ${start} 999 888\n`

afterEach(() => vi.resetAllMocks())

describe('Linux main process start time', () => {
  it('parses field 22 after the last parenthesis in a command with spaces and parentheses', () => {
    expect(parseLinuxProcessStart(stat('12345678'))).toBe(12345678)
  })

  it.each(['', '123 (short) S 0', stat('-1'), stat('1.5'), stat('9007199254740992')])('rejects an invalid stat record', input => {
    expect(() => parseLinuxProcessStart(input)).toThrow('Process start time is unavailable')
  })

  it('reads its own process stat and returns only the start time', () => {
    readStat.mockReturnValue(stat('12345678'))
    const log = vi.fn()
    expect(readLinuxProcessStart(log)).toBe(12345678)
    expect(readStat.mock.calls).toEqual([['/proc/self/stat', 'utf8']])
    expect(log).not.toHaveBeenCalled()
  })

  it.each(['read', 'parse'])('omits start time and logs only a stable name after a %s failure', failure => {
    if (failure === 'read') readStat.mockImplementation(() => { throw new Error('PRIVATE BODY') })
    else readStat.mockReturnValue('PRIVATE BODY')
    const log = vi.fn()
    expect(readLinuxProcessStart(log)).toBeUndefined()
    expect(log.mock.calls).toEqual([['native-dictation-pid-start-unavailable']])
  })
})
