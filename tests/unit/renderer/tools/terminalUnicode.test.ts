import { expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'

it('places CJK and emoji in two cells and combining accents in the preceding cell', async () => {
  const terminal = new Terminal({ allowProposedApi: true })
  try {
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    await new Promise<void>(resolve => terminal.write('A界😀e\u0301Z', resolve))
    const line = terminal.buffer.active.getLine(0)!
    expect([0, 1, 2, 3, 4, 5, 6].map(index => [line.getCell(index)!.getChars(), line.getCell(index)!.getWidth()]))
      .toEqual([['A', 1], ['界', 2], ['', 0], ['😀', 2], ['', 0], ['é', 1], ['Z', 1]])
  } finally { terminal.dispose() }
})
