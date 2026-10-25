import { describe, expect, it, vi } from 'vitest'
import {
  composeQuotedMessage, MAX_REPLY_QUOTES, quoteFromSelection, replyQuoteLabel, ReplyQuoteStore, replyQuoteText, trimBlankLines,
} from '../../../src/renderer/src/agents/replyQuotes'
import { composeReviewMessage } from '../../../src/renderer/src/agents/reviewComments'

describe('the text a reply quote sends', () => {
  it('says where it is from and quotes each line', () => {
    expect(replyQuoteText({ text: '\r\nRead the saved draft first.\r\n\r\nThen skip the write-back.  ' }))
      .toBe('From your earlier reply:\n> Read the saved draft first.\n>\n> Then skip the write-back.')
  })

  it('keeps the first line’s indentation, trimming only blank lines around the words', () => {
    expect(replyQuoteText({ text: '\n\n    if (!key) return\n  done()  \n\n' })).toBe('From your earlier reply:\n>     if (!key) return\n>   done()')
    expect(trimBlankLines(' \n  a\n\n b \n \n')).toBe('  a\n\n b')
    expect(trimBlankLines(' \n \n')).toBe('')
  })

  it('puts the quotes before the message, each set apart by a blank line', () => {
    const quotes = [{ text: 'The first is smaller.' }, { text: 'One source of truth.' }]
    expect(composeQuotedMessage('  Do the first one.\n', quotes)).toBe([
      'From your earlier reply:', '> The first is smaller.', '',
      'From your earlier reply:', '> One source of truth.', '',
      'Do the first one.',
    ].join('\n'))
    expect(composeQuotedMessage('', quotes)).toBe('From your earlier reply:\n> The first is smaller.\n\nFrom your earlier reply:\n> One source of truth.')
    expect(composeQuotedMessage(' Just this. ', [])).toBe('Just this.')
  })

  it('goes quotes, then the message, then the review comments', () => {
    const comment = { path: 'a.ts', lines: [{ kind: 'add' as const, text: 'x', oldLine: null, newLine: 1 }], text: 'Why?' }
    expect(composeReviewMessage(composeQuotedMessage('Fix it.', [{ text: 'It drops the draft.' }]), [comment]))
      .toBe('From your earlier reply:\n> It drops the draft.\n\nFix it.\n\nComment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```')
    expect(composeReviewMessage(composeQuotedMessage('', [{ text: 'It drops the draft.' }]), [comment]))
      .toBe('From your earlier reply:\n> It drops the draft.\n\nComment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```')
  })

  it('labels a chip with the first six words in curly quotes', () => {
    expect(replyQuoteLabel('The draft lives in ThreadDraftStore, keyed by thread ID')).toBe('“The draft lives in ThreadDraftStore, keyed…”')
    expect(replyQuoteLabel(' Two\nwords ')).toBe('“Two words”')
  })
})

describe('the reply quote store', () => {
  it('keeps each thread’s quotes in order, tells subscribers, and takes sent ones off', () => {
    let next = 0
    const store = new ReplyQuoteStore(() => `q${++next}`)
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.add('t1', { messageId: 'm1', text: '\n first  \n' })).toEqual({ id: 'q1', threadId: 't1', messageId: 'm1', text: ' first' })
    store.add('t1', { messageId: 'm2', text: 'second' })
    store.add('t2', { messageId: 'm9', text: 'elsewhere' })
    expect(store.add('t1', { messageId: 'm1', text: '   ' })).toBeNull()
    expect(store.list('t1').map(quote => quote.text)).toEqual([' first', 'second'])
    expect(listener).toHaveBeenCalledTimes(3)
    store.remove('t1', 'q1')
    expect(store.list('t1').map(quote => quote.id)).toEqual(['q2'])
    store.sent('t1', ['q2'])
    expect(store.list('t1')).toEqual([])
    expect(store.list('t2').map(quote => quote.text)).toEqual(['elsewhere'])
    const calls = listener.mock.calls.length
    store.sent('t1', ['q2'])
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('holds at most MAX_REPLY_QUOTES for one prompt', () => {
    const store = new ReplyQuoteStore()
    for (let index = 0; index < MAX_REPLY_QUOTES; index += 1) expect(store.add('t', { messageId: 'm', text: `q${index}` })).not.toBeNull()
    expect(store.full('t')).toBe(true)
    expect(store.add('t', { messageId: 'm', text: 'one more' })).toBeNull()
    expect(store.list('t')).toHaveLength(MAX_REPLY_QUOTES)
  })
})

describe('reading a selection', () => {
  function transcript(): HTMLElement {
    const scroller = document.createElement('div')
    scroller.innerHTML = `
      <article class="thread-message" data-role="user" data-message-id="u1"><div class="rich-message"><p id="mine">My words</p></div></article>
      <article class="thread-message" data-role="assistant" data-message-id="a1"><header id="who">Claude</header>
        <div class="rich-message"><p id="one">The draft lives in the store.</p><p id="two">The loss comes from the editor.</p></div></article>
      <article class="thread-message" data-role="assistant" data-message-id="a2"><div class="rich-message"><p id="other">Another reply.</p></div>
        <div class="thread-message__work-body"><div class="rich-message"><p id="work">Thinking about it.</p></div></div></article>`
    document.body.append(scroller)
    return scroller
  }
  function select(from: Node, start: number, to: Node, end: number): Selection {
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.setBaseAndExtent(from, start, to, end)
    return selection
  }
  const text = (scroller: HTMLElement, id: string): Node => scroller.querySelector(`#${id}`)!.firstChild!

  it('quotes words within one reply, with its message ID', () => {
    const scroller = transcript()
    expect(quoteFromSelection(select(text(scroller, 'one'), 4, text(scroller, 'two'), 8), scroller))
      .toEqual({ messageId: 'a1', text: expect.stringMatching(/^draft lives in the store\.\s*The loss$/u) })
    scroller.remove()
  })

  it('quotes nothing that leaves the reply, comes from the user, or is outside this transcript', () => {
    const scroller = transcript()
    expect(quoteFromSelection(select(text(scroller, 'one'), 0, text(scroller, 'other'), 3), scroller)).toBeNull()
    expect(quoteFromSelection(select(text(scroller, 'who'), 0, text(scroller, 'one'), 3), scroller)).toBeNull()
    expect(quoteFromSelection(select(text(scroller, 'mine'), 0, text(scroller, 'mine'), 5), scroller)).toBeNull()
    expect(quoteFromSelection(select(text(scroller, 'one'), 2, text(scroller, 'one'), 2), scroller)).toBeNull()
    const elsewhere = document.createElement('div')
    document.body.append(elsewhere)
    expect(quoteFromSelection(select(text(scroller, 'one'), 0, text(scroller, 'one'), 3), elsewhere)).toBeNull()
    // The work folded under a reply is not the reply.
    expect(quoteFromSelection(select(text(scroller, 'work'), 0, text(scroller, 'work'), 8), scroller)).toBeNull()
    scroller.remove()
    elsewhere.remove()
  })
})
