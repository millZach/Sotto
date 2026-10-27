import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRows, scrollsTranscript } from '../../../src/renderer/src/agents/readingPlace'

/**
 * The rows a transcript draws keep themselves in the order shown (#1452). What that costs is counted as the page would do
 * the work: a comparison of two rows' places walks the siblings between them, a search of the page visits every element
 * under where it starts, and a look at a neighbouring sibling or up to a parent is one step. Passes the registry makes over
 * its own rows count a slot each, and an insertion counts every slot it shifts.
 */
describe('the rows a transcript draws', () => {
  const all = Element.prototype.querySelectorAll
  const compare = Node.prototype.compareDocumentPosition
  const contains = Node.prototype.contains
  const childIndex = (node: Node): number => Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node) as number
  const under = (element: Element): number => all.call(element, '*').length
  let cost = 0
  const counting = (): void => {
    cost = 0
    vi.spyOn(Node.prototype, 'compareDocumentPosition').mockImplementation(function (this: Node, other: Node) {
      cost += this.parentNode === other.parentNode ? Math.abs(childIndex(this) - childIndex(other)) : under(document.body)
      return compare.call(this, other)
    })
    for (const name of ['querySelectorAll', 'querySelector', 'getElementsByClassName'] as const) {
      const search = Element.prototype[name] as (...args: unknown[]) => unknown
      vi.spyOn(Element.prototype, name).mockImplementation(function (this: Element, ...args: unknown[]) { cost += under(this); return search.apply(this, args) } as never)
    }
    for (const name of ['previousElementSibling', 'nextElementSibling'] as const) {
      const step = Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!
      vi.spyOn(Element.prototype, name, 'get').mockImplementation(function (this: Element) { cost++; return step.call(this) as Element | null })
    }
    vi.spyOn(Node.prototype, 'contains').mockImplementation(function (this: Node, other: Node | null) { cost++; return contains.call(this, other) })
    const splice = Array.prototype.splice
    vi.spyOn(Array.prototype, 'splice').mockImplementation(function (this: unknown[], start: number, ...rest: unknown[]) {
      cost += Math.max(0, this.length - start)
      return (splice as (...args: unknown[]) => unknown[]).call(this, start, ...rest)
    })
    for (const name of ['filter', 'concat', 'indexOf'] as const) {
      const pass = Array.prototype[name] as (...args: unknown[]) => unknown
      vi.spyOn(Array.prototype, name).mockImplementation(function (this: unknown[], ...args: unknown[]) { cost += this.length; return pass.apply(this, args) } as never)
    }
  }
  afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

  const row = (id: string): HTMLElement => {
    const element = Object.assign(document.createElement('article'), { className: 'thread-message', id })
    element.dataset['messageId'] = id
    return element
  }
  /** Every row's message, top first, as the registry gives them. */
  const shown = (rows: MessageRows, transcript: HTMLElement): (string | undefined)[] => rows.inOrder(transcript).map(element => rows.messageOf(element))
  /** A transcript drawing `count` rows, each added as it is drawn and read once, as the transcript reads its rows. */
  function drawing(count: number, name = 'm'): { readonly transcript: HTMLElement; readonly rows: MessageRows; readonly leave: (() => void)[]; readonly drawn: HTMLElement[] } {
    const transcript = document.body.appendChild(document.createElement('div'))
    const rows = new MessageRows()
    const drawn = Array.from({ length: count }, (_, index) => transcript.appendChild(row(`${name}-${index}`)))
    const leave = drawn.map(element => rows.add(element.id, element))
    expect(rows.inOrder(transcript)).toHaveLength(count)
    return { transcript, rows, leave, drawn }
  }

  it('takes in earlier rows drawn above the rest, and lets every row go, in work that grows with the rows', () => {
    const { transcript, rows, leave, drawn: kept } = drawing(500, 'kept')
    // Show earlier: five hundred rows drawn above the ones already there.
    const earlier = Array.from({ length: 500 }, (_, index) => row(`earlier-${index}`))
    transcript.prepend(...earlier)
    counting()
    for (const element of earlier) leave.push(rows.add(element.id, element))
    const size = rows.inOrder(transcript).length
    const taking = cost
    vi.restoreAllMocks()
    expect(size).toBe(1_000)
    expect(shown(rows, transcript)).toEqual([...earlier, ...kept].map(element => element.id))
    // One walk of the page and one pass over the rows found: a few thousand steps for a thousand rows.
    expect(taking).toBeLessThan(5_000)

    // The transcript goes: every row leaves, as React lets each one go before taking the page away.
    counting()
    for (const go of leave) go()
    const left = rows.inOrder(transcript).length
    vi.restoreAllMocks()
    expect(left).toBe(0)
    expect(cost).toBeLessThan(2_500)
  })

  it('takes in a new message at the end in a few steps, however many rows are drawn', () => {
    const { transcript, rows } = drawing(1_000)
    // Between the last message and the new one, the work the turn did.
    transcript.appendChild(document.createElement('section'))
    const newest = transcript.appendChild(row('newest'))
    counting()
    rows.add(newest.id, newest)
    const last = rows.inOrder(transcript).at(-1)
    vi.restoreAllMocks()
    expect(last).toBe(newest)
    expect(cost).toBeLessThanOrEqual(4)
  })

  it('puts a row drawn in the middle where the page shows it, as a fold opening does', () => {
    const { transcript, rows, drawn } = drawing(4)
    const opened = row('opened')
    transcript.insertBefore(opened, drawn[2]!)
    rows.add(opened.id, opened)
    expect(shown(rows, transcript)).toEqual(['m-0', 'm-1', 'opened', 'm-2', 'm-3'])
  })

  it('reads the order again when a row is taken off the page and put back somewhere else', () => {
    const { transcript, rows, leave, drawn } = drawing(3)
    leave[2]!()
    transcript.prepend(drawn[2]!)
    rows.add(drawn[2]!.id, drawn[2]!)
    expect(shown(rows, transcript)).toEqual(['m-2', 'm-0', 'm-1'])
  })

  it('keeps a row drawn and let go before the order was read out of the order', () => {
    const { transcript, rows } = drawing(1)
    const second = transcript.appendChild(row('second'))
    const go = rows.add(second.id, second)
    go()
    second.remove()
    expect(shown(rows, transcript)).toEqual(['m-0'])
    expect(rows.element('second')).toBeUndefined()
  })
})

describe('a key pressed in the transcript', () => {
  const target = (html: string): Element => {
    document.body.innerHTML = `<div role="log">${html}</div>`
    return document.querySelector('[data-target]')!
  }
  const press = (key: string, element: Element, defaultPrevented = false): boolean => scrollsTranscript({ key, target: element, defaultPrevented })

  it('scrolls the transcript when no control takes it', () => {
    const log = target('<p data-target>Answer</p>')
    for (const key of [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']) expect(press(key, log), key).toBe(true)
    expect(press('a', log)).toBe(false)
    expect(press('PageDown', log, true)).toBe(false)
  })

  it('belongs to a field or a widget that moves with the keys', () => {
    for (const html of ['<textarea data-target></textarea>', '<input data-target>', '<div contenteditable="true"><span data-target>x</span></div>',
      '<div role="textbox" data-target></div>', '<div role="menu"><div role="menuitem" data-target></div></div>']) {
      expect(press(' ', target(html)), html).toBe(false)
      expect(press('ArrowDown', target(html)), html).toBe(false)
    }
  })

  it('presses a button, a link or a summary with Space, and still scrolls with the arrows from one', () => {
    for (const html of ['<button data-target>Copy</button>', '<div role="button" data-target></div>', '<a href="#x" data-target>Link</a>',
      '<details><summary data-target>More</summary></details>']) {
      expect(press(' ', target(html)), html).toBe(false)
      expect(press('Enter', target(html)), html).toBe(false)
      expect(press('PageDown', target(html)), html).toBe(true)
    }
  })
})
