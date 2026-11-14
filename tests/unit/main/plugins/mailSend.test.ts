// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { composeMail, draftProblem, encodedSubject, isMailAddress, MAIL_RECIPIENTS_MAX, MAIL_SEND_TEXT_MAX, MAIL_SUBJECT_MAX, mailDate, type MailDraft } from '../../../../src/main/plugins/mail/compose'
import { decodeWords } from '../../../../src/main/plugins/mail/message'
import { sendMail, type MailSendOptions } from '../../../../src/main/plugins/mail/send'
import { smtpData } from '../../../../src/main/plugins/mail/smtpWire'
import { readFakeSmtpMessage, startFakeSmtpServer, type FakeSmtpOptions, type FakeSmtpServer } from '../../../fixtures/fakeSmtpServer'

/**
 * Sending one message from a mail account over SMTP (ADR-0205, slice 9), against a made-up server on this computer.
 * Nothing here is a real address or password, and nothing is sent anywhere.
 */
const ADDRESS = 'sender@example.com'
const PASSWORD = 'made-up app password'
const SIGN_IN = { address: ADDRESS, password: PASSWORD }
const SERVER = { host: 'smtp.mail.example', port: 465 }
const AT = new Date(Date.UTC(2026, 10, 14, 9, 5, 7))
const DRAFT: MailDraft = { to: ['ann@example.com'], subject: 'Lunch on Friday', text: 'Shall we have lunch on Friday?' }

const servers: FakeSmtpServer[] = []
/** What a server was asked before the goodbye, which arrives a moment after a send has answered. */
const asked = (server: FakeSmtpServer): string[] => server.commands.filter(command => command !== 'QUIT')
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
async function smtp(options: Partial<FakeSmtpOptions> = {}): Promise<{ server: FakeSmtpServer; options: MailSendOptions }> {
  const server = await startFakeSmtpServer({ address: ADDRESS, password: PASSWORD, ...options })
  servers.push(server)
  return { server, options: { connect: server.connect, now: () => AT, id: () => 'made-up-id-1' } }
}

describe('sending a message', () => {
  it('signs in, names the sender and everyone it goes to, and hands the message over once', async () => {
    const { server, options } = await smtp()
    const draft: MailDraft = { to: ['ann@example.com', 'ben@example.org'], cc: ['cara@example.com'], bcc: ['dan@example.net', 'ann@EXAMPLE.com'], subject: 'Lunch on Friday', text: 'Shall we have lunch on Friday?\nI can book.\n' }
    expect(await sendMail(SERVER, SIGN_IN, draft, options)).toEqual({ ok: true, recipients: 4, messageId: '<made-up-id-1@example.com>' })
    // The one server it was given, and the commands in the order mail takes them. The sign-in's own words are not kept.
    expect(server.asked).toEqual([SERVER])
    expect(asked(server)).toEqual(['EHLO [127.0.0.1]', 'AUTH PLAIN', `MAIL FROM:<${ADDRESS}>`, 'RCPT TO:<ann@example.com>', 'RCPT TO:<ben@example.org>',
      'RCPT TO:<cara@example.com>', 'RCPT TO:<dan@example.net>', 'DATA'])
    // It says goodbye rather than dropping the connection.
    await expect.poll(() => server.commands.at(-1)).toBe('QUIT')
    expect(server.messages).toHaveLength(1)
    const [message] = server.messages
    // Everyone is named to the server, a Bcc among them, each once however their host is capitalised.
    expect(message).toMatchObject({ from: ADDRESS, to: ['ann@example.com', 'ben@example.org', 'cara@example.com', 'dan@example.net'] })
    const read = readFakeSmtpMessage(message!.data)
    expect(read.headers).toEqual({
      From: ADDRESS, To: 'ann@example.com, ben@example.org', Cc: 'cara@example.com', Subject: 'Lunch on Friday', Date: 'Sat, 14 Nov 2026 09:05:07 +0000',
      'Message-ID': '<made-up-id-1@example.com>', 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Transfer-Encoding': 'base64',
    })
    // A Bcc is in no line of the message, and the text arrives as it was written, with mail's own line ends.
    expect(message!.data).not.toContain('dan@example.net')
    expect(read.text).toBe('Shall we have lunch on Friday?\r\nI can book.\r\n')
    expect(message!.data).not.toContain(PASSWORD)
  })

  it('sends letters outside ASCII in the subject and the text as they were written', async () => {
    const { server, options } = await smtp()
    const subject = 'Rechnung für Oktober, und noch eine sehr lange Zeile über Zoës Frühstück — 日本語のテスト'
    const text = 'Die Rechnung für Oktober liegt bei.\n.\n.. zwei Punkte\nZoë'
    expect((await sendMail(SERVER, SIGN_IN, { ...DRAFT, subject, text }, options)).ok).toBe(true)
    const data = server.messages[0]!.data
    const read = readFakeSmtpMessage(data)
    expect(decodeWords(read.headers.Subject!)).toBe(subject)
    expect(read.text).toBe(text.replace(/\n/gu, '\r\n'))
    // No line a server could refuse for its length, and nothing but ASCII on the wire.
    for (const line of data.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    expect([...data].every(character => character.charCodeAt(0) < 0x80)).toBe(true)
  })

  it('doubles a dot that begins a line, so no line of a message is read as its end', () => {
    expect(smtpData(Buffer.from('a\r\n.\r\n.b\r\n..c', 'latin1')).toString('latin1')).toBe('a\r\n..\r\n..b\r\n...c\r\n.\r\n')
    expect(smtpData(Buffer.from('a\r\n', 'latin1')).toString('latin1')).toBe('a\r\n.\r\n')
  })

  it('says the password was refused, and sends nothing', async () => {
    const { server, options } = await smtp()
    const result = await sendMail(SERVER, { address: ADDRESS, password: 'another made-up password' }, DRAFT, options)
    expect(result).toEqual({ ok: false, reason: 'refused' })
    expect(server.messages).toEqual([])
    expect(server.commands).not.toContain('DATA')
  })

  it('says the server is turning it away for now, apart from a refused password', async () => {
    const { server, options } = await smtp({ authSays: '454 4.7.0 Too many login attempts, please try again later.' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: false, reason: 'busy' })
    const greeted = await smtp({ greeting: '421 4.7.0 Try again later, closing connection.' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, greeted.options)).toMatchObject({ ok: false, reason: 'busy' })
    expect([server.messages, greeted.server.messages]).toEqual([[], []])
  })

  it('sends nothing to anyone when the server will not take one recipient, and names that one', async () => {
    const { server, options } = await smtp({ refuses: { 'gone@example.com': '550 5.1.1 The email account that you tried to reach does not exist.' } })
    const result = await sendMail(SERVER, SIGN_IN, { ...DRAFT, to: ['ann@example.com', 'gone@example.com', 'ben@example.org'] }, options)
    expect(result).toEqual({ ok: false, reason: 'recipient', recipient: 'gone@example.com', said: '5.1.1 The email account that you tried to reach does not exist.' })
    expect(server.messages).toEqual([])
    // It stopped at the one turned away: nobody after it was named, and no message was offered.
    expect(asked(server)).toEqual(['EHLO [127.0.0.1]', 'AUTH PLAIN', `MAIL FROM:<${ADDRESS}>`, 'RCPT TO:<ann@example.com>', 'RCPT TO:<gone@example.com>'])
  })

  it('says a message the server would not take was not sent, in the server’s words', async () => {
    const { server, options } = await smtp({ messageSays: '552 5.3.4 Message size exceeds fixed limit' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: false, reason: 'failed', said: '5.3.4 Message size exceeds fixed limit' })
    expect(server.messages).toEqual([])
    const sender = await smtp({ fromSays: '550 5.7.1 Sending is not allowed for this account' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, sender.options)).toMatchObject({ ok: false, reason: 'failed' })
    const data = await smtp({ dataSays: '451 4.3.0 Try again later' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, data.options)).toMatchObject({ ok: false, reason: 'busy' })
  })

  it('sends to two addresses that differ only in the capitals before the at sign, which the receiving server may tell apart', async () => {
    const { server, options } = await smtp()
    expect(await sendMail(SERVER, SIGN_IN, { ...DRAFT, to: ['Smith@example.org', 'smith@example.org', 'smith@Example.ORG'] }, options)).toMatchObject({ ok: true, recipients: 2 })
    expect(server.messages[0]!.to).toEqual(['Smith@example.org', 'smith@example.org'])
  })

  it('takes an answer that is a code and no words, as a server may give one', async () => {
    const { server, options } = await smtp({ terse: true })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: true, recipients: 1, messageId: '<made-up-id-1@example.com>' })
    expect(server.messages).toHaveLength(1)
  })

  it('reads the answer to a handed-over message by its kind: any yes is sent, a no is not, and anything else is unknown', async () => {
    // A yes that is not 250 is still a message taken. Calling it failed would have the agent send it again.
    const queued = await smtp({ messageSays: '259 Queued' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, queued.options)).toMatchObject({ ok: true, recipients: 1 })
    for (const says of ['999 Unexpected state', '354 Go ahead', '101 Something else']) {
      const { options } = await smtp({ messageSays: says })
      expect(await sendMail(SERVER, SIGN_IN, DRAFT, options), says).toEqual({ ok: false, reason: 'unsure' })
    }
    const later = await smtp({ messageSays: '451 4.3.0 Try again later' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, later.options)).toEqual({ ok: false, reason: 'busy', said: '4.3.0 Try again later' })
  })

  it('says it cannot tell whether a message went when the connection ends after it was handed over', async () => {
    // The whole message reached the server and its answer never came. Saying "not sent" here could send it twice.
    const { options } = await smtp({ dropAt: 'message' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: false, reason: 'unsure' })
  })

  it('says a connection that ends before the message was handed over sent nothing', async () => {
    for (const dropAt of ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']) {
      const { server, options } = await smtp({ dropAt })
      expect(await sendMail(SERVER, SIGN_IN, DRAFT, options), dropAt).toEqual({ ok: false, reason: 'unreachable' })
      expect(server.messages).toEqual([])
    }
  })

  it('gives up on a server that never answers, within the time it was given, and on one it was told to stop waiting for', async () => {
    const silent = await smtp({ greeting: null })
    const started = Date.now()
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, { ...silent.options, timeoutMs: 150 })).toEqual({ ok: false, reason: 'unreachable' })
    expect(Date.now() - started).toBeLessThan(5_000)
    const stopped = new AbortController()
    stopped.abort()
    const { server, options } = await smtp()
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, { ...options, signal: stopped.signal })).toEqual({ ok: false, reason: 'unreachable' })
    expect(server.asked).toEqual([])
    const never: MailSendOptions = { connect: () => new Promise(() => undefined), timeoutMs: 100 }
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, never)).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('does not sign in to a server that takes no password on this connection, or one that answers what is not mail', async () => {
    const { server, options } = await smtp({ offers: ['AUTH XOAUTH2 PLAIN-CLIENTTOKEN', '8BITMIME'] })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: false, reason: 'failed', said: 'The mail server does not take a password on this connection.' })
    expect(asked(server)).toEqual(['EHLO [127.0.0.1]'])
    const web = await smtp({ greeting: 'HTTP/1.1 400 Bad Request' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, web.options)).toEqual({ ok: false, reason: 'failed' })
  })

  it('hands on none of a server’s answer to the sign-in, which could repeat any part of the password', async () => {
    const sent = Buffer.from(`\0${ADDRESS}\0${PASSWORD}`, 'utf8').toString('base64')
    // Whole, cut short, or in pieces across the lines of an answer that repeats its finer code on each, as Gmail's do.
    for (const authSays of [`535 5.7.8 Not accepted: ${PASSWORD}`, `501 5.5.2 Syntax error: AUTH PLAIN ${sent.slice(0, 20)}`,
      `535-5.7.8 Not accepted: ${sent.slice(0, 12)}\r\n535 5.7.8 ${sent.slice(12)}`, `535 5.7.8 ${'Not accepted. '.repeat(40)}`]) {
      const { options } = await smtp({ authSays })
      const result = await sendMail(SERVER, SIGN_IN, DRAFT, options)
      expect(result, authSays).toMatchObject({ ok: false })
      expect(result, authSays).not.toHaveProperty('said')
    }
  })

  it('hands on none of a server’s other words where they repeat the password, the address or the sign-in as it was sent', async () => {
    const sent = Buffer.from(`\0${ADDRESS}\0${PASSWORD}`, 'utf8').toString('base64')
    for (const echoed of [PASSWORD.toUpperCase(), ADDRESS, sent]) {
      const { options } = await smtp({ fromSays: `550 5.7.1 Not allowed: ${echoed} ${'x'.repeat(300)}` })
      expect(await sendMail(SERVER, SIGN_IN, DRAFT, options), echoed).toEqual({ ok: false, reason: 'failed' })
    }
    // An answer of several lines, each starting with the same finer code as Gmail's do, carrying a secret in pieces.
    for (const [first, second] of [[sent.slice(0, 12), sent.slice(12)], [PASSWORD.slice(0, 5), PASSWORD.slice(5)]] as const) {
      const { options } = await smtp({ fromSays: `550-5.7.1 Not allowed: ${first}\r\n550 5.7.1 ${second}` })
      expect(await sendMail(SERVER, SIGN_IN, DRAFT, options), first).toEqual({ ok: false, reason: 'failed' })
    }
    // A password with a control character in it is found in words that come back without one.
    const odd = 'abcd\u0001efgh-made-up'
    const controlled = await startFakeSmtpServer({ address: ADDRESS, password: odd, messageSays: '552 5.3.4 Refused for abcdefgh-made-up' })
    servers.push(controlled)
    expect(await sendMail(SERVER, { address: ADDRESS, password: odd }, DRAFT, { connect: controlled.connect })).toEqual({ ok: false, reason: 'failed' })
    // Other words are handed on, a finer code repeated on each line said once, cut to a line.
    const split = await smtp({ messageSays: '552-5.3.4 Message size exceeds\r\n552 5.3.4 fixed limit' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, split.options)).toEqual({ ok: false, reason: 'failed', said: '5.3.4 Message size exceeds fixed limit' })
    const { options } = await smtp({ fromSays: `550 5.7.1 ${'Not allowed. '.repeat(40)}` })
    const result = await sendMail(SERVER, SIGN_IN, DRAFT, options)
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(result.ok === false && result.said?.length).toBe(200)
  })

  it('hands no message to a server that has already said more than it was asked, so its answer is not misread', async () => {
    // The extra line would be read as the answer to the message: a no for a message the server may then take.
    const { server, options } = await smtp({ dataSays: '354 Go ahead\r\n554 5.0.0 Stale answer' })
    expect(await sendMail(SERVER, SIGN_IN, DRAFT, options)).toEqual({ ok: false, reason: 'failed' })
    expect(server.messages).toEqual([])
  })
})

describe('what is not sent at all', () => {
  it('reaches no server with a draft that is not a message, and says what is wrong with it', async () => {
    const { server, options } = await smtp()
    const cases: readonly (readonly [Partial<MailDraft>, RegExp])[] = [
      [{ to: [] }, /at least one address/u],
      [{ to: ['Ann Example <ann@example.com>'] }, /one plain address/u],
      [{ to: ['ann@example.com\r\nBcc: eve@example.net'] }, /one plain address/u],
      [{ cc: ['ann@example.com, eve@example.net'] }, /one plain address/u],
      [{ bcc: ['ann@localhost'] }, /one plain address/u],
      [{ to: Array.from({ length: MAIL_RECIPIENTS_MAX + 1 }, (_value, index) => `person${index}@example.com`) }, /at most 20 addresses/u],
      [{ subject: '  ' }, /a subject/u],
      [{ subject: 'Hello\r\nBcc: eve@example.net' }, /one line/u],
      [{ subject: 'a'.repeat(MAIL_SUBJECT_MAX + 1) }, /at most 300 characters/u],
      [{ text: ' \n ' }, /some text/u],
      [{ text: 'a'.repeat(MAIL_SEND_TEXT_MAX + 1) }, /at most 100000 characters/u],
      [{ text: 'a\0b' }, /null character/u],
    ]
    for (const [patch, words] of cases) {
      const result = await sendMail(SERVER, SIGN_IN, { ...DRAFT, ...patch }, options)
      expect(result, JSON.stringify(patch).slice(0, 80)).toMatchObject({ ok: false, reason: 'input' })
      expect(result.ok === false && result.said).toMatch(words)
    }
    // An account whose address or password could end a command is not signed in with either.
    for (const signIn of [{ address: 'sender@example.com>\r\nRCPT TO:<eve@example.net', password: PASSWORD }, { address: ADDRESS, password: 'made\r\nup' }, { address: ADDRESS, password: '' }]) {
      expect((await sendMail(SERVER, signIn, DRAFT, options)).ok).toBe(false)
    }
    expect((await sendMail(SERVER, SIGN_IN, DRAFT, { ...options, id: () => 'not a name>' })).ok).toBe(false)
    expect([server.asked, server.commands, server.messages]).toEqual([[], [], []])
  })

  it('counts everyone once, and takes exactly as many as the most', () => {
    const many = Array.from({ length: MAIL_RECIPIENTS_MAX }, (_value, index) => `person${index}@example.com`)
    expect(draftProblem({ ...DRAFT, to: many, cc: [many[0]!.replace('example.com', 'EXAMPLE.COM')] })).toBeNull()
    expect(draftProblem({ ...DRAFT, to: many, bcc: ['one-more@example.com'] })).toMatch(/at most 20/u)
  })
})

describe('a message as it is written', () => {
  it('takes one address and nothing a server would read as more', () => {
    for (const good of ['ann@example.com', 'ann.b+tag@mail.example.org', "o'neil@example.co.uk", `${'a'.repeat(64)}@example.com`]) expect(isMailAddress(good), good).toBe(true)
    for (const bad of ['', 'ann', 'ann@', '@example.com', 'ann@example', 'ann@@example.com', 'ann @example.com', 'ann@example.com ', '<ann@example.com>', 'ann@exam ple.com', 'ann@example.com,ben@example.com',
      'ann@example.com\n', 'ann"@example.com', 'ann@-example.com', 'zoë@example.com', `${'a'.repeat(250)}@example.com`,
      '.ann@example.com', 'ann.@example.com', 'ann..b@example.com', `${'a'.repeat(65)}@example.com`]) expect(isMailAddress(bad), JSON.stringify(bad)).toBe(false)
  })

  it('writes a short plain subject as it is, and anything else as encoded words that read back the same', () => {
    expect(encodedSubject('Lunch on Friday')).toBe('Lunch on Friday')
    for (const subject of ['Zoë', 'a'.repeat(200), '日本語'.repeat(40), 'Looks like =?utf-8?B?an encoded word?=', '🦉 owls 🦉'.repeat(12)]) {
      const written = encodedSubject(subject)
      expect(written).not.toBe(subject)
      for (const line of written.split('\r\n')) expect(`Subject: ${line}`.length).toBeLessThanOrEqual(76)
      expect(decodeWords(written.replace(/\r\n /gu, ' ')), subject.slice(0, 20)).toBe(subject)
    }
  })

  it('writes the day in UTC, and folds a long list of addresses', () => {
    expect(mailDate(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)))).toBe('Sat, 3 Jan 2026 04:05:06 +0000')
    const to = Array.from({ length: 12 }, (_value, index) => `person-number-${index}@example.com`)
    const written = composeMail(ADDRESS, { ...DRAFT, to }, AT, 'made-up-id-2').toString('latin1')
    for (const line of written.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    expect(readFakeSmtpMessage(written).headers.To).toBe(to.join(', '))
    expect(written).not.toContain('Cc:')
    expect(written).not.toContain('Bcc')
  })
})
