import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageRows, scrollsTranscript } from '../../../src/renderer/src/agents/readingPlace'

/**
 * The rows a transcript draws keep themselves in the order shown (#1452). What they cost is counted as the slots the
 * registry visits or moves: each comparison of two rows' places on the page, each slot an insertion shifts, and each slot a
 * pass over the rows reads.
 */
describe('the rows a transcript draws', () => {
  let cost = 0
  const counting = (): void => {
    cost = 0
    const compare = Node.prototype.compareDocumentPosition
    vi.spyOn(Node.prototype, 'compareDocumentPosition').mockImplementation(function (this: Node, other: Node) { cost++; return compare.call(this, other) })
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

  const row = (id: string): HTMLElement => Object.assign(document.createElement('article'), { className: 'thread-message', id })
  /** Every row's message, top first, as the registry gives them. */
  const shown = (rows: MessageRows): (string | undefined)[] => Array.from({ length: rows.size }, (_, index) => rows.messageOf(rows.at(index)!))

  it('takes in earlier rows drawn above the rest, and lets every row go, in work that grows with the rows and not their square', () => {
    const transcript = document.body.appendChild(document.createElement('div'))
    const rows = new MessageRows()
    const kept = Array.from({ length: 500 }, (_, index) => transcript.appendChild(row(`kept-${index}`)))
    const leave = kept.map(element => rows.add(element.id, element))
    expect(rows.size).toBe(500)

    // Show earlier: five hundred rows drawn above the ones already there.
    const earlier = Array.from({ length: 500 }, (_, index) => row(`earlier-${index}`))
    transcript.prepend(...earlier)
    counting()
    for (const element of earlier) leave.push(rows.add(element.id, element))
    const size = rows.size
    const drawing = cost
    vi.restoreAllMocks()
    expect(size).toBe(1_000)
    expect(shown(rows)).toEqual([...earlier, ...kept].map(element => element.id))
    // Sorting a thousand rows takes about ten thousand comparisons; shifting them one insertion at a time took 250,000.
    expect(drawing).toBeLessThan(20_000)

    // The transcript goes: every row leaves, as React lets each one go before taking the page away.
    counting()
    for (const go of leave) go()
    const left = rows.size
    vi.restoreAllMocks()
    expect(left).toBe(0)
    expect(cost).toBeLessThan(5_000)
  })

  it('takes in a new message at the end for the cost of finding its place', () => {
    const transcript = document.body.appendChild(document.createElement('div'))
    const rows = new MessageRows()
    for (let index = 0; index < 1_000; index++) { const element = transcript.appendChild(row(`m${index}`)); rows.add(element.id, element) }
    expect(rows.size).toBe(1_000)
    const newest = transcript.appendChild(row('newest'))
    counting()
    rows.add(newest.id, newest)
    const last = rows.messageOf(rows.at(rows.size - 1)!)
    vi.restoreAllMocks()
    expect(last).toBe('newest')
    expect(cost).toBeLessThanOrEqual(16)
  })

  it('keeps a row drawn and let go before the order was read out of the order', () => {
    const transcript = document.body.appendChild(document.createElement('div'))
    const rows = new MessageRows()
    const first = transcript.appendChild(row('first'))
    const second = transcript.appendChild(row('second'))
    rows.add(first.id, first)
    const go = rows.add(second.id, second)
    go()
    second.remove()
    expect(shown(rows)).toEqual(['first'])
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
