// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkMailSignIn, MAIL_TEXT_MAX_CHARS, openMail, searchMail, type MailOptions, type MailSearch } from '../../../../src/main/plugins/mail/read'
import { startFakeImapServer, type FakeImapOptions, type FakeImapServer, type FakeMailbox } from '../../../fixtures/fakeImapServer'

/** A made-up account on a made-up server: nothing here is a real address or password. */
const ADDRESS = 'reader@example.com'
const PASSWORD = 'made-up app password'
const SIGN_IN = { address: ADDRESS, password: PASSWORD }
const SERVER = { host: 'imap.mail.example', port: 993 }
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
/** A message's name as a search gives it: its mailbox's rebuild count, its number there, and the mailbox by the server's name for it. */
const named = (validity: number, uid: number, mailbox = 'INBOX'): string => `${validity}-${uid}-${Buffer.from(mailbox, 'utf8').toString('base64url')}`

function mailboxes(): FakeMailbox[] {
  return [
    { name: 'INBOX', validity: 7, messages: [
      { uid: 11, seen: true, received: '10-Nov-2026 08:00:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: 'Lunch on Friday' },
        body: { type: 'text/plain', params: { charset: 'utf-8' }, body: 'Shall we have lunch on Friday?\r\n' } },
      { uid: 12, received: '12-Nov-2026 09:30:00 -0500', words: 'Zoë Rechnung für Oktober',
        headers: { From: `=?utf-8?B?${b64('Zoë Example')}?= <zoe@example.com>`, To: ADDRESS, Cc: 'ann@example.com', Subject: '=?utf-8?Q?Rechnung_f=C3=BCr_Oktober?=' },
        body: { multipart: 'mixed', parts: [
          { multipart: 'alternative', parts: [
            { type: 'text/plain', params: { charset: 'utf-8' }, encoding: 'quoted-printable', body: 'Die Rechnung f=C3=BCr Oktober liegt bei.\r\n' },
            { type: 'text/html', params: { charset: 'utf-8' }, encoding: 'base64', body: b64('<p>Die Rechnung für Oktober liegt bei.</p>') },
          ] },
          { type: 'application/pdf', encoding: 'base64', body: b64('made-up pdf bytes'), disposition: 'attachment', filename: 'Rechnung für Oktober.pdf' },
        ] } },
      { uid: 13, received: '13-Nov-2026 07:15:00 +0000', headers: { From: 'News <news@example.org>', To: ADDRESS, Subject: 'This week' },
        body: { type: 'text/html', params: { charset: 'utf-8' }, body: '<html><body><p>Three things this week.</p><p><a href="https://example.org/more">Read more</a></p></body></html>' } },
      { uid: 14, seen: true, received: '13-Nov-2026 07:20:00 +0000', headers: { From: 'Long <long@example.org>', To: ADDRESS, Subject: 'A long one' },
        body: { type: 'text/plain', body: 'a'.repeat(450_000) } },
    ] },
    { name: '[Gmail]/All Mail', marks: ['\\HasNoChildren', '\\All'], validity: 3, messages: [
      { uid: 501, seen: true, received: '01-Oct-2026 12:00:00 +0000', headers: { From: 'Old <old@example.com>', To: ADDRESS, Subject: 'From the archive' }, body: { type: 'text/plain', body: 'Old news.' } },
    ] },
    { name: 'Entw&APw-rfe', marks: ['\\HasNoChildren', '\\Drafts'], validity: 4, messages: [] },
    { name: '[Gmail]', marks: ['\\Noselect', '\\HasChildren'], validity: 1, messages: [] },
  ]
}

const servers: FakeImapServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
async function mail(options: Partial<FakeImapOptions> = {}): Promise<{ fake: FakeImapServer; boxes: FakeMailbox[]; reach: MailOptions }> {
  const boxes = mailboxes()
  const fake = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, mailboxes: boxes, ...options })
  servers.push(fake)
  return { fake, boxes, reach: { connect: fake.connect } }
}
const SIGNED_IN = ['CAPABILITY', 'LOGIN']
const HEADERS = 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT)]'
/** The commands a read sent once it has said goodbye, which it does without waiting. */
const sent = async (fake: FakeImapServer): Promise<string[]> => {
  await vi.waitFor(() => expect(fake.commands.at(-1)).toBe('LOGOUT'))
  return fake.commands
}

describe('checking a mail account’s address and password (ADR-0205)', () => {
  it('signs in to the server it was given, reads nothing and says goodbye', async () => {
    const { fake, reach } = await mail()
    await expect(checkMailSignIn(SERVER, SIGN_IN, reach)).resolves.toEqual({ ok: true })
    expect(fake.asked).toEqual([SERVER])
    expect(await sent(fake)).toEqual([...SIGNED_IN, 'LOGOUT'])
  })

  it('says a refused password is refused in the server’s own words, and never hands the password back', async () => {
    const { fake, reach } = await mail()
    const refused = await checkMailSignIn(SERVER, { address: ADDRESS, password: 'another made-up password' }, reach)
    expect(refused).toEqual({ ok: false, reason: 'refused', said: 'Invalid credentials (Failure)' })
    expect(JSON.stringify(refused)).not.toContain('another made-up password')
    expect(fake.commands).toEqual(SIGNED_IN)
  })

  it('drops the server’s words when they repeat the password or the address', async () => {
    for (const loginSays of [`NO Invalid password ${PASSWORD} for that account`, `NO [AUTHENTICATIONFAILED] No such user ${ADDRESS.toUpperCase()}`]) {
      const { reach } = await mail({ loginSays })
      await expect(checkMailSignIn(SERVER, SIGN_IN, reach)).resolves.toEqual({ ok: false, reason: 'refused' })
    }
  })

  it('drops them too when the password stands past where they are cut, or is written the way a command writes it', async () => {
    const far = await mail({ loginSays: `NO [AUTHENTICATIONFAILED] ${'x'.repeat(180)} pass=${PASSWORD}` })
    await expect(checkMailSignIn(SERVER, SIGN_IN, far.reach)).resolves.toEqual({ ok: false, reason: 'refused' })
    const password = 'pa"ss\\word'
    const escaped = await mail({ password, loginSays: 'NO Could not sign in with "pa\\"ss\\\\word"' })
    await expect(checkMailSignIn(SERVER, { address: ADDRESS, password }, escaped.reach)).resolves.toEqual({ ok: false, reason: 'refused' })

    // Words that hold neither are kept, as one line of no more than 200 characters.
    const long = await mail({ loginSays: `NO ${'Sign in on the web first. '.repeat(20)}` })
    const kept = await checkMailSignIn(SERVER, SIGN_IN, long.reach)
    expect(kept).toMatchObject({ ok: false, reason: 'refused' })
    expect(kept.ok ? '' : kept.said).toHaveLength(200)
  })

  it('sends a password with quotes, slashes or letters outside ASCII so the server reads it whole', async () => {
    for (const password of ['made"up\\pass word', 'gemächt-auf "Paßwort"']) {
      const { reach } = await mail({ password })
      await expect(checkMailSignIn(SERVER, { address: ADDRESS, password }, reach)).resolves.toEqual({ ok: true })
    }
  })

  it('tells a server that is turning sign-ins away from one that refused the password', async () => {
    const crowded = await mail({ loginSays: 'NO [UNAVAILABLE] Too many simultaneous connections. (Failure)' })
    await expect(checkMailSignIn(SERVER, SIGN_IN, crowded.reach)).resolves.toEqual({ ok: false, reason: 'busy', said: 'Too many simultaneous connections. (Failure)' })
    const closing = await mail({ greeting: '* BYE Service not available' })
    await expect(checkMailSignIn(SERVER, SIGN_IN, closing.reach)).resolves.toEqual({ ok: false, reason: 'busy', said: 'Service not available' })
    expect(closing.fake.commands).toEqual([])
  })

  it('sends no password to a server that says it takes none here, or that takes the connection as signed in already', async () => {
    const disabled = await mail({ capabilities: ['LOGINDISABLED', 'STARTTLS'] })
    await expect(checkMailSignIn(SERVER, SIGN_IN, disabled.reach)).resolves.toMatchObject({ ok: false, reason: 'failed' })
    expect(disabled.fake.commands).toEqual(['CAPABILITY'])
    const already = await mail({ greeting: '* PREAUTH Signed in as somebody' })
    await expect(checkMailSignIn(SERVER, SIGN_IN, already.reach)).resolves.toMatchObject({ ok: false, reason: 'failed' })
    expect(already.fake.commands).toEqual([])
  })

  it('speaks only TLS unless it is handed another way to connect, so a password never crosses a network in the clear', async () => {
    const { fake } = await mail()
    // The made-up server speaks no TLS, so the connection is never made and nothing is said to it.
    await expect(checkMailSignIn({ host: '127.0.0.1', port: fake.port }, SIGN_IN)).resolves.toEqual({ ok: false, reason: 'unreachable' })
    expect(fake.commands).not.toContain('LOGIN')
    expect(fake.asked).toEqual([])
  })

  it('says a server that cannot be reached, never answers or drops the connection is unreachable', async () => {
    await expect(checkMailSignIn(SERVER, SIGN_IN, { connect: async () => { throw new Error('No route to the server.') } })).resolves.toEqual({ ok: false, reason: 'unreachable' })
    const silent = await mail({ greeting: null })
    await expect(checkMailSignIn(SERVER, SIGN_IN, { ...silent.reach, timeoutMs: 150 })).resolves.toEqual({ ok: false, reason: 'unreachable' })
    const dropped = await mail({ dropAt: 'UID SEARCH' })
    await expect(searchMail(SERVER, SIGN_IN, { unread: true }, dropped.reach)).resolves.toEqual({ ok: false, reason: 'unreachable' })
    // A connection that is neither made nor refused ends with the time the read has.
    await expect(checkMailSignIn(SERVER, SIGN_IN, { connect: () => new Promise(() => undefined), timeoutMs: 100 })).resolves.toEqual({ ok: false, reason: 'unreachable' })
    // A read its caller stopped is not made.
    const stopped = await mail()
    await expect(checkMailSignIn(SERVER, SIGN_IN, { ...stopped.reach, signal: AbortSignal.abort() })).resolves.toEqual({ ok: false, reason: 'unreachable' })
    expect(stopped.fake.asked).toEqual([])
  })
})

describe('searching a mail account (ADR-0205)', () => {
  it('lists the inbox’s newest messages first, in their own letters, and marks none as read', async () => {
    const { fake, boxes, reach } = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { limit: 3 }, reach)).resolves.toEqual({ ok: true, mailbox: 'INBOX', found: 4, messages: [
      { id: named(7, 14), date: '2026-11-13T07:20:00.000Z', from: 'Long <long@example.org>', to: ADDRESS, subject: 'A long one', unread: false, size: 450_500 },
      { id: named(7, 13), date: '2026-11-13T07:15:00.000Z', from: 'News <news@example.org>', to: ADDRESS, subject: 'This week', unread: true, size: expect.any(Number) },
      { id: named(7, 12), date: '2026-11-12T14:30:00.000Z', from: 'Zoë Example <zoe@example.com>', to: ADDRESS, subject: 'Rechnung für Oktober', unread: true, size: expect.any(Number) },
    ] })
    // With nothing to look for, the server is not asked to number every message: the last three in the mailbox are fetched.
    expect(await sent(fake)).toEqual([...SIGNED_IN, 'EXAMINE INBOX', `FETCH 2:4 (UID FLAGS INTERNALDATE RFC822.SIZE ${HEADERS})`, 'LOGOUT'])
    expect(boxes[0]!.messages.map(message => message.seen)).toEqual([true, undefined, undefined, true])

    // A limit past what the mailbox holds lists all of it, and an empty mailbox is not fetched from.
    const every = await mail()
    await expect(searchMail(SERVER, SIGN_IN, {}, every.reach)).resolves.toMatchObject({ ok: true, found: 4, messages: [{ id: named(7, 14) }, { id: named(7, 13) }, { id: named(7, 12) }, { id: named(7, 11) }] })
    expect(every.fake.commands[3]).toBe(`FETCH 1:4 (UID FLAGS INTERNALDATE RFC822.SIZE ${HEADERS})`)
  })

  it('lists the newest of the messages that match, and says how many matched', async () => {
    const { fake, reach } = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { since: '2026-11-12', limit: 2 }, reach)).resolves.toMatchObject({ ok: true, found: 3, messages: [{ id: named(7, 14) }, { id: named(7, 13) }] })
    expect(fake.commands.slice(3, 5)).toEqual(['UID SEARCH SINCE 12-Nov-2026', `UID FETCH 14,13 (UID FLAGS INTERNALDATE RFC822.SIZE ${HEADERS})`])
  })

  it('searches by sender, subject, words, days and unread, with letters outside ASCII sent as UTF-8', async () => {
    const { fake, reach } = await mail()
    const found = await searchMail(SERVER, SIGN_IN, { from: 'zoë', subject: 'Rechnung', text: 'oktober', since: '2026-11-11', before: '2026-11-13', unread: true }, reach)
    expect(found).toMatchObject({ ok: true, found: 1, messages: [{ id: named(7, 12) }] })
    expect(fake.commands[3]).toBe('UID SEARCH CHARSET UTF-8 FROM zoë SUBJECT Rechnung TEXT oktober SINCE 11-Nov-2026 BEFORE 13-Nov-2026 UNSEEN')

    // Words that only look like a command are sent as words.
    const none = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { subject: 'x" ALL\\' }, none.reach)).resolves.toEqual({ ok: true, mailbox: 'INBOX', found: 0, messages: [] })
    expect(none.fake.commands[3]).toBe('UID SEARCH SUBJECT x" ALL\\')
  })

  it('opens a mailbox by what it is for, or by its own name in its own letters', async () => {
    const all = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { mailbox: 'All' }, all.reach)).resolves.toMatchObject({ ok: true, mailbox: '[Gmail]/All Mail', found: 1, messages: [{ id: named(3, 501, '[Gmail]/All Mail'), subject: 'From the archive' }] })
    expect(all.fake.commands.slice(2, 4)).toEqual(['LIST  *', 'EXAMINE [Gmail]/All Mail'])

    const drafts = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { mailbox: 'entwürfe' }, drafts.reach)).resolves.toEqual({ ok: true, mailbox: 'Entwürfe', found: 0, messages: [] })
    expect(drafts.fake.commands[3]).toBe('EXAMINE Entw&APw-rfe')
  })

  it('opens the mailbox whose name is exactly the one asked for, before one that differs only in its capitals', async () => {
    const boxes: FakeMailbox[] = [{ name: 'INBOX', validity: 1, messages: [] }, { name: 'Work', validity: 2, messages: [] }, { name: 'work', validity: 3, messages: [] }]
    const exact = await mail({ mailboxes: boxes })
    await expect(searchMail(SERVER, SIGN_IN, { mailbox: 'work' }, exact.reach)).resolves.toMatchObject({ ok: true, mailbox: 'work' })
    expect(exact.fake.commands[3]).toBe('EXAMINE work')
    const loose = await mail({ mailboxes: boxes })
    await expect(searchMail(SERVER, SIGN_IN, { mailbox: 'WORK' }, loose.reach)).resolves.toMatchObject({ ok: true, mailbox: 'Work' })
  })

  it('names the account’s mailboxes when the one asked for is not among them, and opens none', async () => {
    const { fake, reach } = await mail()
    await expect(searchMail(SERVER, SIGN_IN, { mailbox: 'Receipts' }, reach)).resolves.toEqual({ ok: false, reason: 'mailbox', mailboxes: ['INBOX', '[Gmail]/All Mail', 'Entwürfe'] })
    expect((await sent(fake)).some(command => command.startsWith('EXAMINE'))).toBe(false)
  })

  it('refuses what it does not read before it connects', async () => {
    const { fake, reach } = await mail()
    const refused = { ok: false, reason: 'input' }
    const searches: MailSearch[] = [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { since: '2026-02-30' }, { before: 'yesterday' }, { text: 'two\nlines' }, { from: '' }, { subject: 'x'.repeat(201) }, { mailbox: 'a\rb' }]
    for (const search of searches) await expect(searchMail(SERVER, SIGN_IN, search, reach)).resolves.toEqual(refused)
    const inbox = Buffer.from('INBOX').toString('base64url')
    const ids = ['12', '7-12', `7-0-${inbox}`, `x-1-${inbox}`, `${named(7, 12)} `, `7-12345678901-${inbox}`, '7-12-!!', `7-12-${inbox}=`, named(7, 12, 'two\rlines'), named(7, 12, '')]
    for (const id of ids) await expect(openMail(SERVER, SIGN_IN, { id }, reach)).resolves.toEqual(refused)
    await expect(checkMailSignIn(SERVER, { address: ADDRESS, password: '' }, reach)).resolves.toEqual(refused)
    await expect(checkMailSignIn(SERVER, { address: 'two\r\nlines', password: PASSWORD }, reach)).resolves.toEqual(refused)
    expect(fake.asked).toEqual([])
  })
})

describe('opening a message (ADR-0205)', () => {
  it('opens a message in the mailbox its search listed it in, though another mailbox numbers one the same', async () => {
    const one = (subject: string, words: string): FakeMailbox['messages'][number] => ({ uid: 1, received: '13-Nov-2026 07:15:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: subject }, body: { type: 'text/plain', body: words } })
    // Two mailboxes may number their messages alike, and count their rebuilds alike.
    const boxes: FakeMailbox[] = [
      { name: 'INBOX', validity: 7, messages: [one('In the inbox', 'Inbox words.')] },
      { name: 'Sent', marks: ['\\HasNoChildren', '\\Sent'], validity: 7, messages: [one('Sent by me', 'Sent words.')] },
    ]
    const { reach } = await mail({ mailboxes: boxes })
    const sentMail = await searchMail(SERVER, SIGN_IN, { mailbox: 'sent' }, reach)
    const inbox = await searchMail(SERVER, SIGN_IN, {}, reach)
    const [sentId, inboxId] = [sentMail.ok ? sentMail.messages[0]!.id : '', inbox.ok ? inbox.messages[0]!.id : '']
    expect(sentId).not.toBe(inboxId)
    await expect(openMail(SERVER, SIGN_IN, { id: sentId }, reach)).resolves.toMatchObject({ ok: true, mailbox: 'Sent', message: { subject: 'Sent by me', text: 'Sent words.' } })
    await expect(openMail(SERVER, SIGN_IN, { id: inboxId }, reach)).resolves.toMatchObject({ ok: true, mailbox: 'INBOX', message: { subject: 'In the inbox', text: 'Inbox words.' } })
  })

  it('reads its plain text and names its files, fetching only the text and leaving it unread', async () => {
    const { fake, boxes, reach } = await mail()
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 12) }, reach)).resolves.toEqual({ ok: true, mailbox: 'INBOX', message: {
      id: named(7, 12), date: '2026-11-12T14:30:00.000Z', from: 'Zoë Example <zoe@example.com>', to: ADDRESS, cc: 'ann@example.com', subject: 'Rechnung für Oktober', unread: true, size: expect.any(Number),
      text: 'Die Rechnung für Oktober liegt bei.\n', fromHtml: false, truncated: false,
      files: [{ name: 'Rechnung für Oktober.pdf', type: 'application/pdf', size: b64('made-up pdf bytes').length }],
    } })
    const commands = await sent(fake)
    expect(commands).toEqual([...SIGNED_IN, 'EXAMINE INBOX', `UID FETCH 12 (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE ${HEADERS})`, 'UID FETCH 12 (BODY.PEEK[1.1]<0.400000>)', 'LOGOUT'])
    // Nothing that could change the mailbox was sent: it was opened for reading only, and every fetch was a peek.
    expect(commands.some(command => /^(?:SELECT|STORE|UID STORE|APPEND|EXPUNGE|COPY|UID COPY|DELETE|CREATE|RENAME)\b/u.test(command) || command.includes('BODY['))).toBe(false)
    expect(boxes[0]!.messages[1]!.seen).toBeUndefined()
  })

  it('reads a message that has only HTML as text, and says so', async () => {
    const { reach } = await mail()
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 13) }, reach)).resolves.toMatchObject({ ok: true, message: { text: 'Three things this week.\nRead more (https://example.org/more)', fromHtml: true, truncated: false, files: [] } })
  })

  it('hands over a message’s text without control characters or marks that turn the text around', async () => {
    const boxes: FakeMailbox[] = [{ name: 'INBOX', validity: 7, messages: [{ uid: 1, received: '13-Nov-2026 07:15:00 +0000',
      headers: { From: 'News <news@example.org>', To: ADDRESS, Subject: 'This week' }, body: { type: 'text/html', params: { charset: 'utf-8' }, body: '<p>hi&#27;[2J&#8238;evil</p>' } }] }]
    const { reach } = await mail({ mailboxes: boxes })
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 1) }, reach)).resolves.toMatchObject({ ok: true, message: { text: 'hi[2Jevil' } })
  })

  it('cuts a long message and says it was cut', async () => {
    const { fake, reach } = await mail()
    const opened = await openMail(SERVER, SIGN_IN, { id: named(7, 14) }, reach)
    expect(opened).toMatchObject({ ok: true, message: { truncated: true } })
    expect(opened.ok && opened.message.text).toBe('a'.repeat(MAIL_TEXT_MAX_CHARS))
    expect(fake.commands[4]).toBe('UID FETCH 14 (BODY.PEEK[1]<0.400000>)')
  })

  it('says when the message is gone, and when its mailbox was rebuilt since the search', async () => {
    const { fake, reach } = await mail()
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 99) }, reach)).resolves.toEqual({ ok: false, reason: 'gone' })
    await expect(openMail(SERVER, SIGN_IN, { id: named(6, 12) }, reach)).resolves.toEqual({ ok: false, reason: 'moved' })
    // The number may be another message's now, so nothing is fetched by it.
    expect(fake.commands.filter(command => command.startsWith('UID FETCH'))).toHaveLength(1)
    // A mailbox that is no longer there is said to be gone, in the server's words.
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 12, 'Receipts') }, reach)).resolves.toEqual({ ok: false, reason: 'mailbox', said: 'Unknown Mailbox: Receipts (Failure)' })
    await expect(openMail(SERVER, SIGN_IN, { id: named(3, 501, '[Gmail]/All Mail') }, reach)).resolves.toMatchObject({ ok: true, mailbox: '[Gmail]/All Mail', message: { text: 'Old news.' } })
  })

  it('stops reading a server that sends more than a message’s text can be', async () => {
    const { reach } = await mail({ claimedBytes: 2_000_000 })
    await expect(openMail(SERVER, SIGN_IN, { id: named(7, 11) }, reach)).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})
