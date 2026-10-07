/** Parse JSON that may contain comments and trailing commas, as VS Code theme files do. */
export function parseJsonc(text: string): unknown {
  let output = ''
  let index = 0
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (char === '"') {
      const start = index
      index += 1
      while (index < source.length && source[index] !== '"') index += source[index] === '\\' ? 2 : 1
      output += source.slice(start, index + 1)
      index += 1
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      output += ' '
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close < 0) throw new SyntaxError('Unterminated JSON comment.')
      index = close + 2
      output += ' '
    } else {
      output += char
      index += 1
    }
  }
  // Remove trailing commas only outside strings, after a possible JSON value.
  // Comments became whitespace so tokens on either side cannot be joined.
  let cleaned = ''
  let quoted = false
  let previous = ''
  for (let cursor = 0; cursor < output.length; cursor += 1) {
    const char = output[cursor]!
    if (quoted) {
      cleaned += char
      if (char === '\\') cleaned += output[++cursor] ?? ''
      else if (char === '"') { quoted = false; previous = char }
      continue
    }
    if (char === '"') quoted = true
    if (char === ',' && /["\d}\]el]/u.test(previous)) {
      let next = cursor + 1
      while (next < output.length && /\s/u.test(output[next]!)) next += 1
      if (output[next] === '}' || output[next] === ']') continue
    }
    cleaned += char
    if (!/\s/u.test(char)) previous = char
  }
  return JSON.parse(cleaned)
}
