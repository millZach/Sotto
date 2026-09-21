import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderedPlainText } from '../../../src/renderer/src/agents/richActions'
import { MessageContent } from '../../../src/renderer/src/agents/MessageContent'

const MD = [
  '## Heading',
  '',
  'A paragraph with **bold** and `code` inline.',
  '',
  '- first item',
  '- second item',
  '',
  '| a | b | c |',
  '| --- | --- | --- |',
  '| 1 | 2 | 3 |',
  '| 4 | 5 | 6 |',
  '',
  '```ts',
  'const one = 1',
  'const two = 2',
  '```',
].join('\n')

afterEach(cleanup)

describe('renderedPlainText', () => {
  it('reads the rendered message as plain text: no Markdown marks, tabbed table, verbatim code', () => {
    const { container } = render(<MessageContent text={MD} />)
    const root = container.querySelector('.rich-message')
    expect(root).not.toBeNull()
    const text = renderedPlainText(root!)
    expect(text).toContain('Heading\n')
    expect(text).not.toMatch(/[#*`|]/u)
    // Table cells are tab-separated, one row per line.
    expect(text).toContain('a\tb\tc')
    expect(text).toContain('1\t2\t3')
    // Code lines keep their written form; the bar's label and status text are not content.
    expect(text).toContain('const one = 1')
    expect(text).toContain('const two = 2')
    expect(text).not.toContain('ts code')
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd())
    expect(text.endsWith('\n')).toBe(false)
  })
})
