// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { PluginSecretLocked } from '../../../../src/main/plugins/accounts'
import { checkMailAccount, MAIL_SERVERS } from '../../../../src/main/plugins/mail/accounts'
import { pluginToolHandlers, type PluginToolWiring } from '../../../../src/main/plugins/toolHandlers'
import { pluginAccountAddSchema, type PluginAccount } from '../../../../src/shared/plugins'
import { startFakeImapServer, type FakeImapOptions, type FakeImapServer } from '../../../fixtures/fakeImapServer'

/** A made-up account on a made-up server: nothing here is a real address or password. */
const ADDRESS = 'reader@example.com'
const PASSWORD = 'madeupapppasswrd'
const PERSONAL: PluginAccount = { id: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal', address: ADDRESS, savedAt: '2026-11-13T08:00:00.000Z', signedInAs: null, on: true, projects: null }

const servers: FakeImapServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
async function mail(options: Partial<FakeImapOptions> = {}): Promise<FakeImapServer> {
  const fake = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, mailboxes: [{ name: 'INBOX', validity: 7, messages: [
    { uid: 12, received: '12-Nov-2026 09:30:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: 'Lunch on Friday' }, body: { type: 'text/plain', body: 'Shall we have lunch on Friday?' } },
  ] }], ...options })
  servers.push(fake)
  return fake
}

describe('a Gmail account (ADR-0205)', () => {
  it('is read at the server Google names for mail programs, over TLS from the first byte', () => {
    expect(MAIL_SERVERS).toEqual({ gmail: { host: 'imap.gmail.com', port: 993 } })
  })

  it('is checked by signing in, and a server that would not answer is not taken for one that refused the password', async () => {
    const good = await mail()
    await expect(checkMailAccount('gmail', ADDRESS, PASSWORD, { connect: good.connect })).resolves.toEqual({ ok: true, signedInAs: null })
    // The address and the password went to Gmail's server and to no other.
    expect(good.asked).toEqual([{ host: 'imap.gmail.com', port: 993 }])
    await expect(checkMailAccount('gmail', ADDRESS, 'anothermadeuppass', { connect: good.connect })).resolves.toEqual({ ok: false, problem: 'refused' })
    await expect(checkMailAccount('gmail', ADDRESS, '', { connect: good.connect })).resolves.toEqual({ ok: false, problem: 'refused' })
    const crowded = await mail({ loginSays: 'NO [UNAVAILABLE] Too many simultaneous connections. (Failure)' })
    await expect(checkMailAccount('gmail', ADDRESS, PASSWORD, { connect: crowded.connect })).resolves.toEqual({ ok: false, problem: 'busy' })
    await expect(checkMailAccount('gmail', ADDRESS, PASSWORD, { connect: async () => { throw new Error('No route to the server.') } })).resolves.toEqual({ ok: false, problem: 'unreachable' })
  })

  it('is added with an address, and no other plugin’s account has one', () => {
    const add = (request: unknown): boolean => pluginAccountAddSchema.safeParse(request).success
    expect(add({ plugin: 'gmail', name: 'Personal', secret: PASSWORD, address: ADDRESS })).toBe(true)
    expect(add({ plugin: 'gmail', name: 'Personal', secret: PASSWORD })).toBe(false)
    expect(add({ plugin: 'vercel', name: 'Work', secret: 'made-up-token', address: ADDRESS })).toBe(false)
    expect(add({ plugin: 'vercel', name: 'Work', secret: 'made-up-token' })).toBe(true)
    // One address, with nothing a mail server would read as more than that.
    for (const address of ['reader', 'reader@', '@example.com', 'a b@example.com', 'reader@example.com\r\nx', '"reader"@example.com', 'Reader <reader@example.com>', 'reader@example.com@example.org']) {
      expect(add({ plugin: 'gmail', name: 'Personal', secret: PASSWORD, address }), address).toBe(false)
    }
  })
})

describe('reading mail as a computer’s plugin tools do (ADR-0205)', () => {
  function handlers(fake: FakeImapServer | null, options: { secret?: () => string; granted?: boolean } = {}) {
    const granted: string[] = []
    const wiring: PluginToolWiring = {
      admits: () => true,
      accounts: { list: async () => [PERSONAL], find: async () => PERSONAL, secret: options.secret ?? (() => PASSWORD) },
      projectOf: () => null, isWatcher: () => false, askChange: async () => 'denied', record: async () => undefined,
      gitHubSignIn: async () => ({ state: 'signed-out' }), gh: async () => '[]',
      vercelFetch: async () => new Response('{}'), vercelOptions: { signal: new AbortController().signal },
      ...(fake ? { mail: {
        grants: { has: async () => options.granted ?? false, grant: async (threadId, accountId) => { granted.push(`${threadId} ${accountId}`); return true }, open: threadId => threadId !== 'thread-settled', generation: () => 4 },
        providerOf: () => 'Claude Code', options: { connect: fake.connect },
      } } : {}),
    }
    return { tools: pluginToolHandlers(wiring), granted }
  }

  it('signs in to the account’s own server with its address and its password from the credential store', async () => {
    const fake = await mail()
    const { tools, granted } = handlers(fake)
    const found = await tools.mail!.search(PERSONAL, {})
    expect(found).toMatchObject({ ok: true, mailbox: 'INBOX', found: 1, messages: [{ subject: 'Lunch on Friday' }] })
    const id = typeof found === 'object' && found.ok ? found.messages[0]!.id : ''
    await expect(tools.mail!.open(PERSONAL, id)).resolves.toMatchObject({ ok: true, message: { text: 'Shall we have lunch on Friday?' } })
    expect(fake.asked).toEqual([{ host: 'imap.gmail.com', port: 993 }, { host: 'imap.gmail.com', port: 993 }])
    // The grants are the computer's own to keep and to ask.
    expect(await tools.mail!.granted('thread-one', PERSONAL.id)).toBe(false)
    expect(tools.mail!.copyOf(PERSONAL.id)).toBe(4)
    await tools.mail!.grant('thread-one', PERSONAL.id, 4)
    expect(granted).toEqual([`thread-one ${PERSONAL.id}`])
    expect(tools.mail!.providerOf('thread-one')).toBe('Claude Code')
    // And whether a thread is open is the grants' own test, the one the grants themselves end by.
    expect([tools.mail!.threadOpen('thread-one'), tools.mail!.threadOpen('thread-settled')]).toEqual([true, false])
  })

  it('connects to nothing when the password cannot be read, or the account is not a mail account with an address', async () => {
    const fake = await mail()
    await expect(handlers(fake, { secret: () => { throw new PluginSecretLocked() } }).tools.mail!.search(PERSONAL, {})).resolves.toBe('locked')
    await expect(handlers(fake, { secret: () => '' }).tools.mail!.open(PERSONAL, '7-12-SU5CT1g')).resolves.toBe('no-secret')
    const noAddress: PluginAccount = { ...PERSONAL, address: undefined }
    await expect(handlers(fake).tools.mail!.search(noAddress, {})).resolves.toBe('no-secret')
    await expect(handlers(fake).tools.mail!.search({ ...PERSONAL, plugin: 'vercel' }, {})).resolves.toBe('no-secret')
    expect(fake.asked).toEqual([])
  })

  it('offers no mail on a computer that was given no way to read it, as a paired host is not yet', () => {
    expect(handlers(null).tools.mail).toBeUndefined()
  })
})
