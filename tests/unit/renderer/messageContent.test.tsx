import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentPreviews, MAX_HIGHLIGHTED_CODE_LENGTH, MessageContent, attachmentTypeLabel, formatAttachmentSize, safeLinkUrl,
} from '../../../src/renderer/src/agents/MessageContent'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { sotto?: unknown }).sotto
})

function stubClipboard(write: (text: string) => Promise<void> = async () => undefined) {
  const writeText = vi.fn(write)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

function assertInert(container: HTMLElement) {
  expect(container.querySelector('script, iframe, object, embed, style, form, svg foreignObject, img, video, audio, link, meta, base')).toBeNull()
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false)
      if (attribute.name === 'href' || attribute.name === 'src') expect(attribute.value).toMatch(/^(https?:\/\/|mailto:)/u)
    }
  }
  // Only title text may quote a rejected destination; no live attribute carries it.
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.name !== 'title') expect(attribute.value).not.toMatch(/javascript:|vbscript:|data:text/iu)
    }
  }
}

describe('rich message Markdown', () => {
  it('renders paragraphs, lists, tables, quotes, headings and inline code as readable blocks', () => {
    const { container } = render(<MessageContent text={[
      '# Result', '', 'The **fix** is in `site/help.html` and ~~old~~ paths are gone.', '',
      '- first', '- second', '  1. nested', '', '- [x] tests pass', '- [ ] deploy', '',
      '> Quoted note', '', '| File | Change |', '| --- | --- |', '| help.html | footer links |',
    ].join('\n')} />)
    expect(screen.getByRole('heading', { name: 'Result', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('fix').tagName).toBe('STRONG')
    expect(screen.getByText('site/help.html').tagName).toBe('CODE')
    expect(screen.getByText('old').tagName).toBe('DEL')
    expect(container.querySelectorAll('ul > li').length).toBeGreaterThanOrEqual(4)
    expect(container.querySelector('ol > li')).toHaveTextContent('nested')
    const tasks = screen.getAllByRole('checkbox')
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toBeChecked()
    for (const task of tasks) expect(task).toBeDisabled()
    expect(container.querySelector('blockquote')).toHaveTextContent('Quoted note')
    const table = screen.getByRole('region', { name: 'Table' })
    expect(table).toHaveAttribute('tabindex', '0')
    expect(within(table).getByRole('columnheader', { name: 'Change' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'footer links' })).toBeInTheDocument()
  })

  it('shows raw HTML as literal text and never creates executable elements or handlers', () => {
    const attack = [
      '<script>alert(1)</script>', '', '<img src=x onerror="alert(2)">', '',
      '<iframe src="https://evil.example"></iframe>', '', '<a href="javascript:alert(3)">html link</a>', '',
      'Inline <b onclick="alert(4)">bold</b> and <style>body{display:none}</style>', '',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
    ].join('\n')
    const { container } = render(<MessageContent text={attack} />)
    assertInert(container)
    expect(container).toHaveTextContent('<script>alert(1)</script>')
    expect(container).toHaveTextContent('<img src=x onerror="alert(2)">')
    expect(container.querySelector('b')).toBeNull()
  })

  it('links only absolute web and mail URLs and leaves every other destination as plain text', () => {
    const onOpenLink = vi.fn(() => ({ ok: true }))
    const unsafe = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java%0ascript:alert(1)', 'vbscript:msgbox', 'data:text/html;base64,PHNjcmlwdD4=',
      'file:///C:/Windows/System32/cmd.exe', 'ms-settings:privacy', '//evil.example', '../relative/path', 'C:\\Users\\me\\secret.txt',
      'https://user:secret@example.com', '#user-content-fn-1']
    const { container } = render(<MessageContent onOpenLink={onOpenLink} text={[
      '[docs](https://example.com/docs?q=1)', '<https://auto.example/path>', '[mail](mailto:team@example.com)',
      ...unsafe.map((url, index) => `[bad ${index}](${url})`),
    ].join('\n\n')} />)
    const anchors = container.querySelectorAll('a')
    expect([...anchors].map(anchor => anchor.getAttribute('href'))).toEqual(['https://example.com/docs?q=1', 'https://auto.example/path', 'mailto:team@example.com'])
    for (const anchor of anchors) expect(anchor).toHaveAttribute('rel', 'noopener noreferrer')
    unsafe.forEach((_url, index) => expect(screen.getByText(`bad ${index}`).closest('a')).toBeNull())
    assertInert(container)
    expect(safeLinkUrl(' https://example.com ')).toBe('https://example.com/')
    expect(safeLinkUrl('https:\\\\example.com')).toBeNull()
  })

  it('opens a link through the callback on click or Enter and never navigates the window', async () => {
    const user = userEvent.setup()
    const onOpenLink = vi.fn(async () => ({ ok: true }))
    render(<MessageContent text="See [the docs](https://example.com/docs)." onOpenLink={onOpenLink} />)
    const link = screen.getByRole('link', { name: 'the docs' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    await waitFor(() => expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs'))
    await user.tab()
    expect(link).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onOpenLink).toHaveBeenCalledTimes(2))
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    act(() => { link.dispatchEvent(middle) })
    expect(middle.defaultPrevented).toBe(true)
  })

  it('uses the main-process link bridge by default and offers Copy link when opening fails', async () => {
    const openExternalLink = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const }))
    ;(window as { sotto?: unknown }).sotto = { openExternalLink }
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<MessageContent text="[status page](https://status.example.com/today)" />)
    await user.click(screen.getByRole('link', { name: 'status page' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://status.example.com/today')
    expect(await screen.findByText('Could not open status.example.com.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith('https://status.example.com/today')
    expect(await screen.findByText('Link copied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })

  it('reports a failure when no link bridge exists', async () => {
    const user = userEvent.setup()
    render(<MessageContent text="[site](https://example.com)" />)
    await user.click(screen.getByRole('link', { name: 'site' }))
    expect(await screen.findByText('Could not open example.com.')).toBeInTheDocument()
  })

  it('never loads Markdown images, remote or inline, and labels them instead', () => {
    const { container } = render(<MessageContent text={`![tracking pixel](https://tracker.example/p.gif?u=1)\n\n![inline](${PNG})\n\n![](javascript:alert(1))`} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: 'Image not loaded: tracking pixel' })).toHaveTextContent('not loaded from tracker.example')
    expect(screen.getByRole('img', { name: 'Image not loaded: inline' })).toHaveTextContent('not loaded')
    expect(container.innerHTML).not.toContain('tracker.example/p.gif')
    assertInert(container)
  })
})

describe('code blocks', () => {
  it('uses the main-owned copy-only path when browser clipboard permission is denied', async () => {
    const user = userEvent.setup()
    const browserCopy = stubClipboard(async () => { throw new Error('Browser clipboard denied') })
    const deliverOutput = vi.fn<NonNullable<Window['sotto']>['deliverOutput']>().mockResolvedValue('copied')
    Object.defineProperty(window, 'sotto', { configurable: true, value: { deliverOutput } })
    render(<MessageContent text={'```ts\n  const answer = 42;\n```'} />)
    await user.click(screen.getByRole('button', { name: 'Copy ts code' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(deliverOutput).toHaveBeenCalledWith({ text: '  const answer = 42;', autoPaste: false, pasteDelayMs: 50 })
    expect(browserCopy).not.toHaveBeenCalled()
    deliverOutput.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    await user.click(screen.getByRole('button', { name: 'Copy ts code' }))
    expect(await screen.findByText('Copy failed')).toBeInTheDocument()
    expect(browserCopy).not.toHaveBeenCalled()
  })

  it('highlights declared languages without HTML injection and copies the exact code with feedback', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    const code = 'const greeting = "<img src=x onerror=alert(1)>"\nfunction run() { return 42 }'
    const { container } = render(<MessageContent text={`\`\`\`ts\n${code}\n\`\`\``} />)
    const block = screen.getByLabelText('ts code block')
    expect(block.tagName).toBe('PRE')
    expect(block.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(block.querySelector('.hljs-string')).toHaveTextContent('"<img src=x onerror=alert(1)>"')
    expect(block).toHaveTextContent('function run() { return 42 }')
    assertInert(container)
    await user.click(screen.getByRole('button', { name: 'Copy ts code' }))
    expect(writeText).toHaveBeenCalledWith(code)
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('reaches the copy control and the scrollable code by keyboard and reports copy failures', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => { throw new Error('denied') })
    render(<MessageContent text={'```\nplain text line that is very long '.padEnd(400, 'x') + '\n```'} />)
    expect(screen.getByText('Code')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Copy failed')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByLabelText('Code code block')).toHaveFocus()
  })

  it('shows unknown and oversized code as plain text', () => {
    const huge = 'let x = 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHTED_CODE_LENGTH / 11) + 10)
    const { container } = render(<MessageContent text={`\`\`\`not-a-language\nlet y = 2\n\`\`\`\n\n\`\`\`js\n${huge}\`\`\``} />)
    expect(screen.getByText('not-a-language')).toBeInTheDocument()
    expect(container.querySelector('.hljs-keyword')).toBeNull()
    expect(container.querySelectorAll('pre')[1]!.textContent!.length).toBeGreaterThan(MAX_HIGHLIGHTED_CODE_LENGTH)
  })
})

describe('streaming', () => {
  const answer = [
    'Here is the **plan**:', '', '1. Read `src/app.ts`', '2. Fix [the link](https://example.com/a)', '',
    '| Step | State |', '| --- | --- |', '| build | ok |', '', '```ts', 'export const done = true', '```', '',
    '> <script>alert(1)</script> stays text', '', '![pixel](https://tracker.example/x.gif)',
  ].join('\n')

  it('renders every partial prefix of an answer safely and keeps earlier content stable', () => {
    const view = render(<MessageContent text="" streaming />)
    for (let end = 1; end <= answer.length; end += 5) {
      view.rerender(<MessageContent text={answer.slice(0, end)} streaming />)
      assertInert(view.container)
    }
    view.rerender(<MessageContent text={answer} streaming={false} />)
    assertInert(view.container)
    expect(screen.getByRole('link', { name: 'the link' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Table' })).toBeInTheDocument()
    expect(screen.getByLabelText('ts code block')).toHaveTextContent('export const done = true')
  })

  it('shows an unfinished fence as code and an unfinished link as text while streaming', () => {
    const view = render(<MessageContent text={'Working on it\n\n```py\nprint("hi")\n[unfinished](https://exa'} streaming />)
    expect(view.container.querySelector('.rich-message')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByLabelText('py code block')).toHaveTextContent('print("hi")')
    view.rerender(<MessageContent text={'Working on it [unfinished](https://exa'} streaming />)
    expect(screen.queryByRole('link', { name: 'unfinished' })).toBeNull()
    expect(view.container).toHaveTextContent('[unfinished](https://exa')
    view.rerender(<MessageContent text={'Working on it [unfinished](https://example.com)'} />)
    expect(view.container.querySelector('.rich-message')).not.toHaveAttribute('aria-busy')
    expect(screen.getByRole('link', { name: 'unfinished' })).toBeInTheDocument()
  })

  it('keeps a code block copy state while more text streams in after it', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const first = '```sh\nnpm test\n```\n\nRunning'
    const view = render(<MessageContent text={first} streaming />)
    await user.click(screen.getByRole('button', { name: 'Copy sh code' }))
    view.rerender(<MessageContent text={`${first} the suite now.`} streaming />)
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })
})

describe('attachment previews', () => {
  it('shows a validated submitted image with readable name, type and size', () => {
    render(<AttachmentPreviews attachments={[{ id: 'a', name: 'footer.png', mimeType: 'image/png', sizeBytes: 1_468_006, preview: { dataUrl: PNG } }]} />)
    const image = screen.getByRole('img', { name: 'footer.png' })
    expect(image).toHaveAttribute('src', PNG)
    expect(screen.getByRole('list', { name: 'Attachment' })).toHaveTextContent('footer.pngPNG · 1.4 MB')
  })

  it('falls back to metadata for unsafe, mismatched, missing or broken previews', () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg onload="alert(1)"/>')}`
    const html = `data:text/html;base64,${btoa('<script>alert(1)</script>')}`
    const mismatched = `data:image/jpeg;base64,${PNG.split(',')[1]}`
    const { container } = render(<AttachmentPreviews attachments={[
      { id: '1', name: 'vector.svg', mimeType: 'image/svg+xml', sizeBytes: 30, preview: { dataUrl: svg } },
      { id: '2', name: 'page.png', mimeType: 'image/png', sizeBytes: 30, preview: { dataUrl: html } },
      { id: '3', name: 'remote.png', mimeType: 'image/png', sizeBytes: 30, preview: { dataUrl: 'https://tracker.example/x.png' } },
      { id: '4', name: 'wrong.jpg', mimeType: 'image/jpeg', sizeBytes: 30, preview: { dataUrl: mismatched } },
      { id: '5', name: 'evicted.png', mimeType: 'image/png', sizeBytes: 2048 },
      { id: '6', name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 12_000 },
      { id: '7', name: 'pending.png' },
    ]} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.getByText('evicted.png').parentElement).toHaveTextContent('PNG · 2 KB · Preview unavailable')
    expect(screen.getByText('notes.pdf').parentElement).toHaveTextContent('PDF · 12 KB · No preview for this file type')
    expect(screen.getByText('pending.png').parentElement).toHaveTextContent(/^pending\.png$/u)
    expect(container.innerHTML).not.toMatch(/tracker\.example|svg\+xml;base64|text\/html/u)
  })

  it('replaces a preview the browser cannot decode with metadata', () => {
    const { container } = render(<AttachmentPreviews attachments={[{ id: 'a', name: 'shot.png', mimeType: 'image/png', sizeBytes: 900, preview: { dataUrl: PNG } }]} />)
    fireEvent.error(screen.getByRole('img', { name: 'shot.png' }))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('shot.png').parentElement).toHaveTextContent('PNG · 900 B · Preview could not be shown')
  })

  it('strips bidirectional controls from names and shows a provider limit note', () => {
    render(<AttachmentPreviews notice="This model does not support screenshots." attachments={[{ id: 'a', name: 'invoice\u202Egnp.exe', mimeType: 'application/octet-stream', sizeBytes: 10 }]} />)
    expect(screen.getByText('invoicegnp.exe')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('This model does not support screenshots.')
  })

  it('renders nothing without attachments or a note', () => {
    const { container } = render(<AttachmentPreviews attachments={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('formats sizes and type labels defensively', () => {
    expect(formatAttachmentSize(undefined)).toBeNull()
    expect(formatAttachmentSize(-1)).toBeNull()
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(10)).toBe('10 B')
    expect(formatAttachmentSize(1536)).toBe('2 KB')
    expect(formatAttachmentSize(25 * 1024 * 1024)).toBe('25 MB')
    expect(attachmentTypeLabel('image/webp')).toBe('WEBP')
    expect(attachmentTypeLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('OPENXMLFORMA')
    expect(attachmentTypeLabel('text/plain; charset=utf-8')).toBe('PLAIN')
    expect(attachmentTypeLabel('<script>')).toBe('File')
  })
})
