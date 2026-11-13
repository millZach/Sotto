// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { atomOf, IMAP_LITERAL_MAX, ImapFrames, imapItems, ImapProtocolError, listOf, textOf } from '../../../../src/main/plugins/mail/imapWire'

describe('a mail server’s answers as they arrive (ADR-0205)', () => {
  /** Every whole answer in what has arrived so far. */
  const answers = (frames: ImapFrames, arrived: string | Buffer): (string | Buffer)[][] => {
    frames.add(Buffer.from(arrived))
    const whole: (string | Buffer)[][] = []
    for (let next = frames.next(); next; next = frames.next()) whole.push(next)
    return whole
  }

  it('waits for a whole line, and for every byte of a literal, however the pieces arrive', () => {
    const frames = new ImapFrames()
    expect(answers(frames, '* 3 EXISTS')).toEqual([])
    // A line's end can itself arrive in two pieces.
    expect(answers(frames, '\r')).toEqual([])
    expect(answers(frames, '\n* 4')).toEqual([['* 3 EXISTS']])
    expect(answers(frames, ' EXISTS\r\n* 5 EXISTS\r\n')).toEqual([['* 4 EXISTS'], ['* 5 EXISTS']])

    // A literal is bytes, whatever they are: a bracket or a line end inside one ends nothing.
    expect(answers(frames, '* 1 FETCH (BODY[1] {7}\r\nhe)\r\n')).toEqual([])
    expect(answers(frames, 'lo FLAGS ())\r\nS1 OK done\r\n')).toEqual([['* 1 FETCH (BODY[1] ', Buffer.from('he)\r\nlo'), ' FLAGS ())'], ['S1 OK done']])
    // Only a number in curly brackets at a line's very end is a literal's size.
    expect(answers(frames, '* OK see {5} and {x}\r\n* OK {}\r\n')).toEqual([['* OK see {5} and {x}'], ['* OK {}']])
    // And never in a line that says how things stand, whose words may end in anything.
    expect(answers(frames, '* OK note {5}\r\nS1 NO [ALERT] Try again {12}\r\n+ go on {3}\r\n* BYE {1}\r\n')).toEqual([['* OK note {5}'], ['S1 NO [ALERT] Try again {12}'], ['+ go on {3}'], ['* BYE {1}']])
  })

  it('refuses a literal or a line longer than it takes, so a server cannot fill this computer’s memory', () => {
    const literal = new ImapFrames()
    expect(() => answers(literal, `* 1 FETCH (BODY[1] {${IMAP_LITERAL_MAX + 1}}\r\n`)).toThrow(ImapProtocolError)
    expect(answers(new ImapFrames(), `* 1 FETCH (BODY[1] {${IMAP_LITERAL_MAX}}\r\n`)).toEqual([])
    const line = new ImapFrames()
    expect(answers(line, Buffer.alloc(3_000_000, 0x61))).toEqual([])
    expect(() => answers(line, Buffer.alloc(1_000_001, 0x61))).toThrow(ImapProtocolError)
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
