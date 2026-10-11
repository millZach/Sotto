// @vitest-environment node
import { expect, it } from 'vitest'
import { TerminalAgentExitSignal } from '../../../src/main/terminals/exitSignal'

it('reads a launcher exit across every PTY chunk boundary without retaining its marker', () => {
  const example = new TerminalAgentExitSignal()
  for (let boundary = 0; boundary <= example.body.length + 2; boundary++) {
    const signal = new TerminalAgentExitSignal(), marker = `\x1b${signal.body}\x07`
    const first = signal.write('last provider output\r\n' + marker.slice(0, boundary))
    const last = signal.write(marker.slice(boundary) + 'shell prompt')
    expect(Number(first.exited) + Number(last.exited)).toBe(1)
    expect(first.output + last.output).toBe('last provider output\r\nshell prompt')
    expect(signal.flush()).toBe('')
  }
})

it('rejects a different run marker and ordinary exit text, and suppresses duplicate own markers', () => {
  const signal = new TerminalAgentExitSignal(), other = new TerminalAgentExitSignal()
  const wrong = `codex exited with code 0.\r\n\x1b${other.body}\x07`
  expect(signal.write(wrong)).toEqual({ output: wrong, exited: false })
  const marker = `\x1b${signal.body}\x07`
  expect(signal.write(marker + marker)).toEqual({ output: '', exited: true })
  expect(signal.write(marker.slice(0, 5))).toEqual({ output: '', exited: false })
  expect(signal.write(marker.slice(5) + 'still a shell')).toEqual({ output: 'still a shell', exited: false })
})

it('preserves ordinary escape sequences when a potential marker prefix mismatches or the PTY ends', () => {
  const signal = new TerminalAgentExitSignal()
  expect(signal.write('text\x1b')).toEqual({ output: 'text', exited: false })
  expect(signal.write('[31mred')).toEqual({ output: '\x1b[31mred', exited: false })
  expect(signal.write('\x1b]')).toEqual({ output: '', exited: false })
  expect(signal.flush()).toBe('\x1b]')
})
