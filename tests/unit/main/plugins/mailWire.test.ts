// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { atomOf, IMAP_LITERAL_MAX, imapItems, ImapProtocolError, listOf, takeFrame, textOf } from '../../../../src/main/plugins/mail/imapWire'

describe('a mail server’s answers as they arrive (ADR-0205)', () => {
  it('waits for a whole line, and for every byte of a literal', () => {
    expect(takeFrame(Buffer.from('* 3 EXISTS'))).toBeNull()
    expect(takeFrame(Buffer.from('* 3 EXISTS\r\n* 4'))).toEqual({ parts: ['* 3 EXISTS'], used: 12 })

    // A literal is bytes, whatever they are: a bracket or a line end inside one ends nothing.
    const first = '* 1 FETCH (BODY[1] {7}\r\nhe)\r\nlo FLAGS ())\r\n'
    const whole = Buffer.from(`${first}S1 OK done\r\n`)
    expect(takeFrame(whole.subarray(0, 30))).toBeNull()
    expect(takeFrame(whole)).toEqual({ parts: ['* 1 FETCH (BODY[1] ', Buffer.from('he)\r\nlo'), ' FLAGS ())'], used: first.length })
  })

  it('refuses a literal or a line longer than it takes, so a server cannot fill this computer’s memory', () => {
    expect(() => takeFrame(Buffer.from(`* 1 FETCH (BODY[1] {${IMAP_LITERAL_MAX + 1}}\r\n`))).toThrow(ImapProtocolError)
    expect(() => takeFrame(Buffer.alloc(200_001, 0x61))).toThrow(ImapProtocolError)
    expect(takeFrame(Buffer.from(`* 1 FETCH (BODY[1] {${IMAP_LITERAL_MAX}}\r\n`))).toBeNull()
  })

  it('reads atoms, strings and lists, and keeps what stands in an atom’s square brackets whole', () => {
    const [verb, marks, delimiter, name] = imapItems(['LIST (\\HasNoChildren \\All) "/" "[Gmail]/All \\"Mail\\""'])
    expect(atomOf(verb)).toBe('LIST')
    expect(listOf(marks).map(atomOf)).toEqual(['\\HASNOCHILDREN', '\\ALL'])
    expect([textOf(delimiter), textOf(name)]).toEqual(['/', '[Gmail]/All "Mail"'])
    // A string is not an atom, and an atom is not a list.
    expect([atomOf(name), listOf(verb)]).toEqual([null, []])

    const fetched = imapItems(['3 FETCH (UID 7 BODY[HEADER.FIELDS (FROM TO)] ', Buffer.from('From: a\r\n\r\n'), ' BODY[1]<0> NIL)'])
    expect(fetched.slice(0, 2).map(atomOf)).toEqual(['3', 'FETCH'])
    const fields = listOf(fetched[2])
    expect(fields.map(atomOf)).toEqual(['UID', '7', 'BODY[HEADER.FIELDS (FROM TO)]', null, 'BODY[1]<0>', 'NIL'])
    expect([textOf(fields[3]), textOf(fields[5]), textOf(undefined)]).toEqual(['From: a\r\n\r\n', '', ''])
  })

  it('refuses an answer whose lists or strings do not close', () => {
    for (const broken of ['(a (b)', 'a)', '"never ends', '"ends in a slash\\', '('.repeat(70)]) expect(() => imapItems([broken])).toThrow(ImapProtocolError)
  })
})
