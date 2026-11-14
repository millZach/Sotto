// @vitest-environment node
import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { checkMailSignIn, mailServerAnswers, searchMail, type MailServer } from '../../../../src/main/plugins/mail/read'
import { sendMail } from '../../../../src/main/plugins/mail/send'
import { BRIDGE_CERTIFICATE, CHANGED_CERTIFICATE } from '../../../fixtures/bridgeCertificates'
import { startFakeImapServer, type FakeImapOptions, type FakeImapServer } from '../../../fixtures/fakeImapServer'
import { readFakeSmtpMessage, startFakeSmtpServer, type FakeSmtpOptions, type FakeSmtpServer } from '../../../fixtures/fakeSmtpServer'

/**
 * Reading and sending through a server that begins in the clear and is made TLS by STARTTLS, with a certificate of
 * its own, as Proton Mail Bridge on this computer is (ADR-0205, slice 10). The stand-ins are made-up servers on this
 * computer, and every address, password and message is made up.
 */
const ADDRESS = 'reader@proton.example'
const PASSWORD = 'made-up bridge password'
const SIGN_IN = { address: ADDRESS, password: PASSWORD }
/** The SHA-256 of a certificate as Sotto keeps it. */
const kept = (cert: string): string => new X509Certificate(cert).fingerprint256.replace(/:/gu, '').toLowerCase()
const BRIDGE = kept(BRIDGE_CERTIFICATE.cert)
const imapAt = (certificate: string): MailServer => ({ host: '127.0.0.1', port: 1143, startTls: { certificate } })
const smtpAt = (certificate: string): MailServer => ({ host: '127.0.0.1', port: 1025, startTls: { certificate } })

const closing: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())) })
async function imap(options: Partial<FakeImapOptions> = {}): Promise<FakeImapServer> {
  const fake = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, startTls: BRIDGE_CERTIFICATE, capabilities: ['UIDPLUS'], mailboxes: [
    { name: 'INBOX', validity: 3, messages: [{ uid: 7, received: '13-Nov-2026 09:30:00 +0000', headers: { From: 'ann@example.com', To: ADDRESS, Subject: 'Lunch on Friday' }, body: { type: 'text/plain', body: 'Shall we?' } }] },
    // As Bridge lists them: by name, with no marks saying what each is for.
    { name: 'All Mail', validity: 4, messages: [] }, { name: 'Sent', validity: 5, messages: [] }, { name: 'Spam', validity: 6, messages: [] },
  ], ...options })
  closing.push(() => fake.close())
  return fake
}
async function smtp(options: Partial<FakeSmtpOptions> = {}): Promise<FakeSmtpServer> {
  const fake = await startFakeSmtpServer({ address: ADDRESS, password: PASSWORD, startTls: BRIDGE_CERTIFICATE, ...options })
  closing.push(() => fake.close())
  return fake
}

describe('reading through STARTTLS', () => {
  it('learns the certificate on a check, then reads only from a server that shows it, signing in only over TLS', async () => {
    const fake = await imap()
    expect(await checkMailSignIn(imapAt('learn'), SIGN_IN, { connect: fake.connect })).toEqual({ ok: true, certificate: BRIDGE })
    // Nothing but what makes the connection TLS is said in the clear.
    expect(fake.commands.slice(0, 4)).toEqual(['CAPABILITY', 'STARTTLS', 'CAPABILITY', 'LOGIN'])
    const found = await searchMail(imapAt(BRIDGE), SIGN_IN, {}, { connect: fake.connect })
    expect(found).toMatchObject({ ok: true, mailbox: 'INBOX', found: 1 })
  })

  it('sends nothing to a server showing another certificate, as a reinstalled Bridge or another program would', async () => {
    const fake = await imap({ startTls: CHANGED_CERTIFICATE })
    expect(await searchMail(imapAt(BRIDGE), SIGN_IN, {}, { connect: fake.connect })).toEqual({ ok: false, reason: 'certificate' })
    expect(await checkMailSignIn(imapAt(BRIDGE), SIGN_IN, { connect: fake.connect })).toEqual({ ok: false, reason: 'certificate' })
    expect(fake.commands).not.toContain('LOGIN')
  })

  it('reads nothing a server sent in the clear after its yes to STARTTLS, and does not sign in', async () => {
    const fake = await imap({ startTls: { ...BRIDGE_CERTIFICATE, unasked: 'S3 OK [CAPABILITY IMAP4rev1] Pretend this came over TLS\r\n' } })
    expect(await checkMailSignIn(imapAt('learn'), SIGN_IN, { connect: fake.connect })).toMatchObject({ ok: false, reason: 'failed' })
    expect(fake.commands).not.toContain('LOGIN')
  })

  it('does not sign in to a server that offers no TLS', async () => {
    const fake = await imap({ startTls: undefined })
    expect(await checkMailSignIn(imapAt('learn'), SIGN_IN, { connect: fake.connect })).toEqual({ ok: false, reason: 'failed', said: 'The mail server does not offer TLS.' })
    expect(fake.commands).toEqual(['CAPABILITY'])
  })

  it('learns a certificate only on a check, and begins in the clear only on this computer', async () => {
    const fake = await imap()
    expect(await searchMail(imapAt('learn'), SIGN_IN, {}, { connect: fake.connect })).toEqual({ ok: false, reason: 'input' })
    expect(await checkMailSignIn({ host: 'mail.example', port: 1143, startTls: { certificate: 'learn' } }, SIGN_IN, { connect: fake.connect })).toEqual({ ok: false, reason: 'input' })
    expect(await checkMailSignIn(imapAt('not-a-certificate'), SIGN_IN, { connect: fake.connect })).toEqual({ ok: false, reason: 'input' })
    expect(fake.asked).toEqual([])
  })

  it('finds a mailbox by what it is for when the server marks none, as Bridge marks none', async () => {
    const fake = await imap()
    expect(await searchMail(imapAt(BRIDGE), SIGN_IN, { mailbox: 'all' }, { connect: fake.connect })).toMatchObject({ ok: true, mailbox: 'All Mail' })
    expect(await searchMail(imapAt(BRIDGE), SIGN_IN, { mailbox: 'sent' }, { connect: fake.connect })).toMatchObject({ ok: true, mailbox: 'Sent' })
    expect(await searchMail(imapAt(BRIDGE), SIGN_IN, { mailbox: 'spam' }, { connect: fake.connect })).toMatchObject({ ok: true, mailbox: 'Spam' })
    // A name that is no mailbox says so and names the ones there, whatever word it is.
    for (const mailbox of ['constructor', '__proto__', 'Receipts']) {
      expect(await searchMail(imapAt(BRIDGE), SIGN_IN, { mailbox }, { connect: fake.connect }), mailbox).toEqual({ ok: false, reason: 'mailbox', mailboxes: ['INBOX', 'All Mail', 'Sent', 'Spam'] })
    }
  })
})

describe('sending through STARTTLS', () => {
  const DRAFT = { to: ['ann@example.com'], subject: 'Lunch on Friday', text: 'Shall we have lunch on Friday?' }

  it('makes the connection TLS before signing in, and hands the message over', async () => {
    const fake = await smtp()
    expect(await sendMail(smtpAt(BRIDGE), SIGN_IN, DRAFT, { connect: fake.connect, id: () => 'made-up-id' })).toMatchObject({ ok: true, recipients: 1 })
    expect(fake.commands.slice(0, 4)).toEqual(['EHLO [127.0.0.1]', 'STARTTLS', 'EHLO [127.0.0.1]', 'AUTH PLAIN'])
    expect(readFakeSmtpMessage(fake.messages[0]!.data).text).toBe('Shall we have lunch on Friday?')
  })

  it('sends nothing, and signs in to nothing, when the certificate is another or a server adds words in the clear', async () => {
    const changed = await smtp({ startTls: CHANGED_CERTIFICATE })
    expect(await sendMail(smtpAt(BRIDGE), SIGN_IN, DRAFT, { connect: changed.connect })).toEqual({ ok: false, reason: 'certificate' })
    const added = await smtp({ startTls: { ...BRIDGE_CERTIFICATE, unasked: '250 2.0.0 Pretend this came over TLS' } })
    expect(await sendMail(smtpAt(BRIDGE), SIGN_IN, DRAFT, { connect: added.connect })).toMatchObject({ ok: false, reason: 'failed' })
    const none = await smtp({ startTls: undefined })
    expect(await sendMail(smtpAt(BRIDGE), SIGN_IN, DRAFT, { connect: none.connect })).toEqual({ ok: false, reason: 'failed', said: 'The mail server does not offer TLS.' })
    for (const fake of [changed, added, none]) {
      expect(fake.commands.some(command => command.startsWith('AUTH'))).toBe(false)
      expect(fake.messages).toEqual([])
    }
  })

  it('never sends with a certificate it is only learning', async () => {
    const fake = await smtp()
    expect(await sendMail(smtpAt('learn'), SIGN_IN, DRAFT, { connect: fake.connect })).toMatchObject({ ok: false, reason: 'input' })
    expect(fake.asked).toEqual([])
  })
})

describe('whether a server answers', () => {
  it('says whether anything is listening at a port on this computer, and sends it nothing', async () => {
    const fake = await imap()
    expect(await mailServerAnswers(imapAt(BRIDGE), { connect: fake.connect })).toBe(true)
    // One stopped before it began connects to nothing.
    expect(await mailServerAnswers(imapAt(BRIDGE), { connect: fake.connect, signal: AbortSignal.abort() })).toBe(false)
    expect(fake.asked).toHaveLength(1)
    // A port nothing listens on, as Bridge's while it is closed.
    const listener = createServer()
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>(resolve => listener.close(() => resolve()))
    expect(await mailServerAnswers({ host: '127.0.0.1', port, startTls: { certificate: BRIDGE } })).toBe(false)
    expect(await mailServerAnswers({ host: 'mail.example', port: 1143, startTls: { certificate: BRIDGE } })).toBe(false)
    await expect.poll(() => fake.commands).toEqual([])
  })
})
