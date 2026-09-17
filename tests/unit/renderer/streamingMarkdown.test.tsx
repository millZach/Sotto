import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options } from 'react-markdown'

// Every parse goes through this counter, so a re-parse of an already finished block is visible.
const parses = vi.hoisted(() => ({ sources: [] as string[] }))
vi.mock('react-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  const Markdown = actual.default
  return {
    ...actual,
    default: function CountedMarkdown(options: Options) {
      parses.sources.push(String(options.children ?? ''))
      return <Markdown {...options} />
    },
  }
})

import { MessageContent, splitStreamingMarkdown } from '../../../src/renderer/src/agents/MessageContent'

afterEach(() => {
  cleanup()
  parses.sources.length = 0
})

/** The rendered blocks alone: the link feedback, and the whitespace between blocks that CSS discards, are not markup. */
function blocks(container: HTMLElement): string {
  const message = container.querySelector('.rich-message')!.cloneNode(true) as HTMLElement
  message.querySelector('.rich-message__feedback')!.remove()
  for (const node of [...message.childNodes]) if (node.nodeType === Node.TEXT_NODE && !node.textContent!.trim()) node.remove()
  return message.innerHTML
}

function markup(text: string, streaming: boolean): string {
  const { container } = render(<MessageContent text={text} streaming={streaming} />)
  const html = blocks(container)
  cleanup()
  return html
}

/** Feeds the text in chunks the way a provider does, then returns the final markup. */
function streamed(text: string, step = 7): string {
  const view = render(<MessageContent text="" streaming />)
  for (let end = 1; end < text.length; end += step) view.rerender(<MessageContent text={text.slice(0, end)} streaming />)
  view.rerender(<MessageContent text={text} streaming />)
  const html = blocks(view.container)
  cleanup()
  return html
}

const DOCUMENTS: readonly { name: string; text: string }[] = [
  { name: 'an open fence', text: ['Working on it', '', '```py', 'print("hi")', 'more = 1'].join('\n') },
  { name: 'a closed fence followed by prose', text: ['Done', '', '```ts', 'export const a = 1', '```', '', 'That is all.'].join('\n') },
  { name: 'a nested list with a loose item', text: ['Steps:', '', '- first', '  - inner', '', '- second', '', '  continued in the item', '', 'After the list.'].join('\n') },
  { name: 'a table', text: ['Results:', '', '| File | Change |', '| --- | --- |', '| a.ts | edited |', '| b.ts | added |', '', 'Next.'].join('\n') },
  { name: 'a blockquote', text: ['Note:', '', '> quoted line', '> second line', '', '> a second quote', '', 'End.'].join('\n') },
  { name: 'reference links', text: ['See [the docs][docs] and [more].', '', '[docs]: https://example.com/docs', '[more]: https://example.com/more', '', 'Done.'].join('\n') },
  { name: 'a footnote', text: ['A claim.[^1]', '', 'More prose.', '', '[^1]: The evidence.'].join('\n') },
  { name: 'indented code across a blank line', text: ['Example:', '', '    first();', '', '    second();', '', 'Done.'].join('\n') },
  { name: 'a setext heading', text: ['Intro.', '', 'Heading', '=======', '', 'Body.'].join('\n') },
  { name: 'an HTML comment and a script', text: ['Before', '', '<!-- a note', 'over two lines -->', '', 'After'].join('\n') },
  { name: 'an ordered list interrupted by a heading', text: ['1. one', '2. two', '', '## Then', '', 'Body text with `code`.'].join('\n') },
  { name: 'task items and a thematic break', text: ['- [x] done', '- [ ] todo', '', '---', '', 'Closing paragraph.'].join('\n') },
  { name: 'a list that continues after a fence', text: ['- step one', '', '  ```sh', '  npm test', '  ```', '', '- step two', '', 'After the list.'].join('\n') },
  { name: 'a fence opened inside a list item', text: ['Steps:', '', '1. run it', '', '   ```js', '   const a = 1', '', '   const b = 2', '   ```', '', '2. read the output', '', 'Done.'].join('\n') },
  { name: 'a heading straight after a fence', text: ['Before', '', '```ts', 'const a = 1', '```', '## Then', 'Body without a blank line.'].join('\n') },
  { name: 'tilde fences around a backtick fence', text: ['Look:', '', '~~~md', '```ts', 'const a = 1', '```', '~~~', '', 'That is the markdown.'].join('\n') },
  { name: 'a tilde fence holding blank lines', text: ['Output:', '', '~~~', 'first', '', 'second', '~~~', '', 'End.'].join('\n') },
  { name: 'a table straight after a fence', text: ['```sh', 'npm test', '```', '', '| File | Change |', '| --- | --- |', '| a.ts | edited |', '', 'Then prose.'].join('\n') },
]

describe('splitting a message being written', () => {
  it('always restores the message when the parts are joined', () => {
    for (const { name, text } of DOCUMENTS) expect(splitStreamingMarkdown(text).join(''), name).toBe(text)
    for (const { text } of DOCUMENTS) {
      for (let end = 0; end <= text.length; end += 3) expect(splitStreamingMarkdown(text.slice(0, end)).join('')).toBe(text.slice(0, end))
    }
  })

  it('renders the same text streamed as it does whole', () => {
    for (const { name, text } of DOCUMENTS) {
      const whole = markup(text, false)
      expect(markup(text, true), name).toBe(whole)
      // Chunk sizes that land the boundaries in different places, including one byte at a time.
      for (const step of [1, 3, 7, 13]) expect(streamed(text, step), `${name} in ${step}-byte chunks`).toBe(whole)
    }
  })

  it('never ends a finished block inside an open fence', () => {
    const open = ['Before', '', '```js', 'const a = 1', '', 'const b = 2'].join('\n')
    const segments = splitStreamingMarkdown(open)
    expect(segments).toEqual(['Before\n\n', '```js\nconst a = 1\n\nconst b = 2'])
    expect(splitStreamingMarkdown('~~~\ntext\n\nmore')).toEqual(['~~~\ntext\n\nmore'])
  })

  it('keeps a message whole when a construct reaches across the blank line', () => {
    expect(splitStreamingMarkdown('- one\n\n- two')).toEqual(['- one\n\n- two'])
    expect(splitStreamingMarkdown('- one\n\n  continued')).toEqual(['- one\n\n  continued'])
    expect(splitStreamingMarkdown('> one\n\n> two')).toEqual(['> one\n\n> two'])
    expect(splitStreamingMarkdown('    code\n\n    more')).toEqual(['    code\n\n    more'])
    expect(splitStreamingMarkdown('Heading\n\n=====')).toEqual(['Heading\n\n====='])
    expect(splitStreamingMarkdown('See [a].\n\n[a]: https://example.com')).toEqual(['See [a].\n\n[a]: https://example.com'])
    expect(splitStreamingMarkdown('Before\n\n<!-- note -->\n\nAfter')).toEqual(['Before\n\n<!-- note -->\n\nAfter'])
  })

  it('ends a finished block at the blank line after a top-level fence', () => {
    // Nothing after the blank line can reach into a closed top-level fence, not even a list.
    expect(splitStreamingMarkdown('```sh\nnpm test\n```\n\n- one\n- two')).toEqual(['```sh\nnpm test\n```\n\n', '- one\n- two'])
    expect(splitStreamingMarkdown('Before\n\n```sh\nnpm test\n```\n\n> quoted')).toEqual(['Before\n\n', '```sh\nnpm test\n```\n\n', '> quoted'])
    expect(splitStreamingMarkdown('~~~\nnpm test\n~~~\n\n  indented')).toEqual(['~~~\nnpm test\n~~~\n\n', '  indented'])
    // An indented fence belongs to the list item above it, which the next item still continues.
    expect(splitStreamingMarkdown('- one\n\n  ```sh\n  npm test\n  ```\n\n- two')).toEqual(['- one\n\n  ```sh\n  npm test\n  ```\n\n- two'])
    // A fence that does not start its own block could be inside one.
    expect(splitStreamingMarkdown('- one\n```sh\nnpm test\n```\n\n- two')).toEqual(['- one\n```sh\nnpm test\n```\n\n- two'])
    // The fence has to be closed: a message that ends on one is all still being written.
    expect(splitStreamingMarkdown('```sh\nnpm test\n\n- one')).toEqual(['```sh\nnpm test\n\n- one'])
  })

  it('separates plain finished blocks', () => {
    expect(splitStreamingMarkdown('One.\n\nTwo.\n\nThr')).toEqual(['One.\n\n', 'Two.\n\n', 'Thr'])
    expect(splitStreamingMarkdown('# Title\n\n```sh\nnpm test\n```\n\n| a |\n| - |\n\nEnd')).toEqual(
      ['# Title\n\n', '```sh\nnpm test\n```\n\n', '| a |\n| - |\n\n', 'End'])
  })
})

describe('parsing only the block being written', () => {
  it('leaves finished blocks alone while the last one grows', () => {
    const start = ['# Plan', '', '```ts', 'export const done = true', '```', '', 'Now I am writing'].join('\n')
    const view = render(<MessageContent text={start} streaming />)
    expect(parses.sources).toEqual(['# Plan\n\n', '```ts\nexport const done = true\n```\n\n', 'Now I am writing'])
    parses.sources.length = 0
    view.rerender(<MessageContent text={`${start} the last paragraph.`} streaming />)
    expect(parses.sources).toEqual(['Now I am writing the last paragraph.'])
    parses.sources.length = 0
    view.rerender(<MessageContent text={`${start} the last paragraph. And more.`} streaming />)
    expect(parses.sources).toEqual(['Now I am writing the last paragraph. And more.'])
  })

  it('parses a whole answer once per new block rather than once per chunk', () => {
    const text = ['One paragraph.', '', 'Two paragraph.', '', 'Three paragraph.'].join('\n')
    const view = render(<MessageContent text="" streaming />)
    for (let end = 1; end <= text.length; end += 1) view.rerender(<MessageContent text={text.slice(0, end)} streaming />)
    const reparsedPrefix = parses.sources.filter(source => source.startsWith('One paragraph.\n\nTwo'))
    expect(reparsedPrefix).toHaveLength(0)
    // Each parse is of one block, never of everything written so far.
    expect(parses.sources.every(source => source.length <= 'Three paragraph.'.length + 2)).toBe(true)
  })

  it('parses a small fraction of the characters a whole-message re-read would', () => {
    const text = [
      '## Plan',
      ...Array.from({ length: 12 }, (_, index) => `Step ${index + 1}: the loader reads \`src/app.ts\` twice, so the second read wins and the retry path runs again.`),
      '```ts\nexport const done = true\nexport const retries = 3\n```',
      'That leaves the retry path, which I will fix next.',
    ].join('\n\n')
    const view = render(<MessageContent text="" streaming />)
    let reread = 0
    for (let end = 1; end <= text.length; end += 4) {
      view.rerender(<MessageContent text={text.slice(0, end)} streaming />)
      reread += end
    }
    const parsed = parses.sources.reduce((total, source) => total + source.length, 0)
    expect(parsed).toBeLessThan(reread / 8)
  })

  it('renders a finished message as one document', () => {
    const text = 'One.\n\nTwo.\n\nThree.'
    render(<MessageContent text={text} />)
    expect(parses.sources).toEqual([text])
  })
})

describe('the caret and the busy state', () => {
  const streamingCaret = '.rich-message[data-streaming] > p:nth-last-child(2)'
  const listCaret = '.rich-message[data-streaming] > ul:nth-last-child(2) > li:last-child'

  it('puts the caret on the last paragraph of the block being written', () => {
    const { container } = render(<MessageContent text={'Earlier block.\n\nThe newest paragraph'} streaming />)
    expect(container.querySelector(streamingCaret)).toHaveTextContent('The newest paragraph')
  })

  it('puts the caret on the last item of a list being written', () => {
    const { container } = render(<MessageContent text={'Steps:\n\n- first\n- second'} streaming />)
    expect(container.querySelector(listCaret)).toHaveTextContent('second')
  })

  it('carries the busy state only while writing, and drops the caret when finished', () => {
    const view = render(<MessageContent text={'Earlier block.\n\nLast paragraph.'} streaming />)
    const message = (): Element => view.container.querySelector('.rich-message')!
    expect(message()).toHaveAttribute('data-streaming', 'true')
    expect(message()).toHaveAttribute('aria-busy', 'true')
    view.rerender(<MessageContent text={'Earlier block.\n\nLast paragraph.'} />)
    expect(message()).not.toHaveAttribute('data-streaming')
    expect(message()).not.toHaveAttribute('aria-busy')
    expect(view.container.querySelector(streamingCaret)).toBeNull()
  })

  it('keeps a long code block in a finished part unhighlighted', () => {
    const long = `const x = 1\n`.repeat(2_000)
    const { container } = render(<MessageContent text={`Here:\n\n\`\`\`ts\n${long}\`\`\`\n\nStill writing`} streaming />)
    const code = container.querySelector('.rich-code code')!
    expect(code.textContent!.length).toBeGreaterThan(20_000)
    expect(code.querySelector('span')).toBeNull()
  })
})
