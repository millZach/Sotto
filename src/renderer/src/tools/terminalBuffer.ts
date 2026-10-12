import type { IBuffer } from '@xterm/xterm'

export function terminalLineStart(buffer: IBuffer, row: number): number {
  while (row > 0 && buffer.getLine(row)?.isWrapped) row--
  return row
}

/** Read one output line across soft wraps, optionally ending at a cell position. */
export function terminalLineText(buffer: IBuffer, row: number, end?: { row: number; column: number }): string {
  const first = terminalLineStart(buffer, row)
  let text = ''
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line || y > first && !line.isWrapped) break
    if (end && y === end.row) return text + line.translateToString(false, 0, end.column)
    const next = buffer.getLine(y + 1), wraps = next?.isWrapped
    let part = line.translateToString(!wraps)
    // A wide glyph can wrap before the last cell; xterm leaves that cell empty rather than part of the text.
    const last = line.getCell(line.length - 1)
    if (wraps && last?.getCode() === 0 && last.getWidth() === 1 && next?.getCell(0)?.getWidth() === 2) part = part.slice(0, -1)
    text += part
  }
  return text
}

/** Map a text offset back to cells after reflow, including wide and combining glyphs. */
export function terminalTextPosition(buffer: IBuffer, first: number, offset: number): { row: number; column: number } | null {
  for (let row = first; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line || row > first && !line.isWrapped) break
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column)
      if (!cell || !cell.getWidth()) continue
      if (cell.getCode() === 0 && column === line.length - 1 && buffer.getLine(row + 1)?.isWrapped && buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue
      const length = (cell.getChars() || ' ').length
      if (offset < length) return { row, column }
      offset -= length
    }
  }
  return null
}
