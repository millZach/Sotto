// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { imapItems } from '../../../../src/main/plugins/mail/imapWire'
import { attachedParts, decodeMailboxName, decodePart, decodeWords, htmlToText, mailHeaders, mailParts, textPart } from '../../../../src/main/plugins/mail/message'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
/** A message's structure as a server writes it, read the way an answer is. */
const structure = (text: string) => imapItems([text])[0]

describe('a mail message as a person reads it (ADR-0205)', () => {
  it('reads header lines in their own letters, unfolded, the first of a name winning', () => {
    expect(decodeWords(`=?UTF-8?B?${b64('Zoë Example')}?= <zoe@example.com>`)).toBe('Zoë Example <zoe@example.com>')
    expect(decodeWords('=?iso-8859-1?Q?Andr=E9_Pirard?=')).toBe('André Pirard')
    // White space between two encoded words is not part of the text; a character set nobody knows is read as UTF-8.
    expect(decodeWords('=?utf-8?Q?Rech?= =?utf-8?Q?nung?= bitte')).toBe('Rechnung bitte')
    expect(decodeWords('=?x-made-up?Q?plain?=')).toBe('plain')

    const headers = mailHeaders(Buffer.from('From: "Ann" <ann@example.com>\r\nSubject: one\r\n two\r\nsubject: second\r\nno colon here\r\n\r\n'))
    expect([...headers]).toEqual([['from', '"Ann" <ann@example.com>'], ['subject', 'one two']])
  })

  it('finds the text among a message’s parts and names the files, without opening a message sent along inside', () => {
    const parts = mailParts(structure('((("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 120 4 NIL NIL NIL NIL)'
      + '("text" "html" ("charset" "utf-8") NIL NIL "base64" 900 12 NIL NIL NIL NIL) "alternative" ("boundary" "x") NIL NIL NIL)'
      + '("application" "pdf" ("name" "=?utf-8?Q?r=C3=A9sum=C3=A9.pdf?=") NIL NIL "base64" 5000 NIL ("attachment" ("filename*" "utf-8\'\'r%C3%A9sum%C3%A9%20final.pdf")) NIL NIL)'
      + '("message" "rfc822" NIL NIL NIL "7bit" 300 (NIL "inside" NIL NIL NIL NIL NIL NIL NIL NIL) ("text" "plain" NIL NIL NIL "7bit" 10 1) 9 NIL ("attachment" ("filename" "forwarded.eml")) NIL NIL)'
      + '("image" "png" NIL "<logo@example.com>" NIL "base64" 700 NIL ("inline" NIL) NIL NIL)'
      + ' "mixed" ("boundary" "y") NIL NIL NIL)'))
    expect(parts.map(part => [part.section, part.type, part.encoding, part.size, part.name, part.attached])).toEqual([
      ['1.1', 'text/plain', 'quoted-printable', 120, null, false],
      ['1.2', 'text/html', 'base64', 900, null, false],
      ['2', 'application/pdf', 'base64', 5000, 'résumé final.pdf', true],
      ['3', 'message/rfc822', '7bit', 300, 'forwarded.eml', true],
      ['4', 'image/png', 'base64', 700, null, false],
    ])
    const text = textPart(parts)
    expect(text?.section).toBe('1.1')
    // The HTML beside the plain text is the same message again, not a file. A picture set in the text is one.
    expect(attachedParts(parts, text).map(part => part.section)).toEqual(['2', '3', '4'])

    // A message that is one part is part 1; one with no plain text is read from its HTML.
    const html = mailParts(structure('("text" "html" ("charset" "iso-8859-1") NIL NIL "7bit" 40 1 NIL NIL NIL NIL)'))
    expect(html).toEqual([{ section: '1', type: 'text/html', charset: 'iso-8859-1', encoding: '7bit', size: 40, name: null, attached: false }])
    expect(textPart(html)).toBe(html[0])

    // A text file that was attached is a file, not the message's text. A name in encoded words is read too.
    const file = mailParts(structure('("text" "plain" ("name" "=?utf-8?B?' + b64('Notizen.txt') + '?=") NIL NIL "7bit" 5 1 NIL ("attachment" NIL) NIL NIL)'))
    expect(textPart(file)).toBeNull()
    expect(attachedParts(file, null).map(part => part.name)).toEqual(['Notizen.txt'])
    expect(mailParts(structure('NIL'))).toEqual([])
  })

  it('never takes a file for the message’s text, whichever way the sender marked it', () => {
    const html = '("text" "html" NIL NIL NIL "7bit" 30 1 NIL NIL NIL NIL)'
    // A group of parts marked as attached: everything in it is a file.
    const group = mailParts(structure(`(${html}(("text" "plain" NIL NIL NIL "7bit" 20 1 NIL NIL NIL NIL)("text" "plain" NIL NIL NIL "7bit" 25 1 NIL NIL NIL NIL) "mixed" ("boundary" "z") ("attachment" ("filename" "bundle")) NIL NIL) "mixed" ("boundary" "y") NIL NIL NIL)`))
    expect(group.map(part => [part.section, part.attached])).toEqual([['1', false], ['2.1', true], ['2.2', true]])
    expect(textPart(group)?.section).toBe('1')
    expect(attachedParts(group, textPart(group)).map(part => part.section)).toEqual(['2.1', '2.2'])

    // A text part with a file name and no mark at all is a file too.
    const named = mailParts(structure(`(${html}("text" "plain" ("name" "notes.txt") NIL NIL "7bit" 20 1 NIL NIL NIL NIL) "mixed" ("boundary" "y") NIL NIL NIL)`))
    expect(textPart(named)?.section).toBe('1')
    expect(attachedParts(named, textPart(named)).map(part => part.name)).toEqual(['notes.txt'])
    // A message that is one text part and nothing else is that text, name or no name.
    const only = mailParts(structure('("text" "plain" ("name" "body.txt") NIL NIL "7bit" 5 1 NIL NIL NIL NIL)'))
    expect(textPart(only)).toBe(only[0])
  })

  it('reads a part’s text from base64, quoted-printable and other character sets', () => {
    expect(decodePart(Buffer.from(b64('Grüße aus Köln\r\nbis bald')), { encoding: 'base64', charset: 'utf-8' }, false)).toBe('Grüße aus Köln\nbis bald')
    expect(decodePart(Buffer.from('Gr=C3=BC=C3=9Fe=\r\n aus K=C3=B6ln'), { encoding: 'quoted-printable', charset: 'UTF-8' }, false)).toBe('Grüße aus Köln')
    expect(decodePart(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { encoding: '8bit', charset: 'iso-8859-1' }, false)).toBe('café')
    expect(decodePart(Buffer.from('1 = 1 and a=b'), { encoding: 'quoted-printable', charset: null }, false)).toBe('1 = 1 and a=b')
  })

  it('drops a last character that a cut left unfinished, and does not show it as damage', () => {
    // Five letters of base64 are one whole group and a piece: the group ends half way through é.
    expect(decodePart(Buffer.from(b64('aaé').slice(0, 5)), { encoding: 'base64', charset: 'utf-8' }, true)).toBe('aa')
    expect(decodePart(Buffer.from('caf=C3'), { encoding: 'quoted-printable', charset: 'utf-8' }, true)).toBe('caf')
    expect(decodePart(Buffer.from('caf=C'), { encoding: 'quoted-printable', charset: 'utf-8' }, true)).toBe('caf')
  })

  it('makes plain text of an HTML message: nothing hidden, a line for each block, a link with its address', () => {
    expect(htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><!-- hidden --><p>Hello&nbsp;<b>Ann</b> &amp; all</p>'
      + '<div>See <a href="https://example.com/x">the page</a> or <a href=\'https://example.com/y\'>https://example.com/y</a>, or <a href="mailto:ann@example.com">write</a>.</div>'
      + '<script>alert(1)</script><br>Bye &#233;&#x1F600; &unknown;</body></html>'))
      .toBe('Hello Ann & all\nSee the page (https://example.com/x) or https://example.com/y, or write.\n\nBye é😀 &unknown;')
    // What never closes takes the rest with it, as it does on a page.
    expect(htmlToText('<p>shown</p><script>never closed <p>not shown</p>')).toBe('shown')
    expect(htmlToText('<p>shown</p><!-- never closed <p>not shown</p>')).toBe('shown')
    // A message is whatever its sender wrote: none of these may take long.
    expect(htmlToText('<!--'.repeat(50_000))).toBe('')
    expect(htmlToText(`${'<a href="https://example.com">'.repeat(20_000)}x`)).toBe('x')
    expect(htmlToText(`a${' <b> </b>'.repeat(20_000)} b`)).toBe('a b')
    // A link inside a link is not HTML: the newest one opened is the link, and each is looked through once.
    const nested = (count: number): string => `${Array.from({ length: count }, (_none, index) => `<a href="https://example.com/${index}">`).join('')}x${'</a>'.repeat(count)}`
    expect(htmlToText(nested(3))).toBe('x (https://example.com/2)')
    expect(htmlToText(nested(10_000))).toBe('x (https://example.com/9999)')
  })

  it('reads a mailbox’s name in its own letters', () => {
    expect(decodeMailboxName('Entw&APw-rfe')).toBe('Entwürfe')
    expect(decodeMailboxName('[Gmail]/All Mail')).toBe('[Gmail]/All Mail')
    expect(decodeMailboxName('Tom &- Jerry')).toBe('Tom & Jerry')
  })
})
