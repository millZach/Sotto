// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { MailFound, MailOpened, MailSearch } from '../../../../src/main/plugins/mail/read'
import type { PluginChangeAnswer } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer, type SecretTrouble } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { PLUGIN_ACCOUNTS_TOOL, PLUGIN_READ_TOOL, pluginAccountAdmits, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'

const servers: PluginToolServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

/** Made-up accounts: nothing here is a real address. */
const PERSONAL: PluginAccount = { id: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal', address: 'reader@example.com', savedAt: '2026-11-13T08:00:00.000Z', signedInAs: null, on: true, projects: null }
const WORK: PluginAccount = { ...PERSONAL, id: '33333333-3333-4333-8333-000000000002', name: 'Work', address: 'reader@example.org' }
const FOUND: MailFound = { ok: true, mailbox: 'INBOX', found: 1, messages: [{ id: '7-12-SU5CT1g', date: '2026-11-12T14:30:00.000Z', from: 'Ann Example <ann@example.com>', to: 'reader@example.com', subject: 'Lunch on Friday', unread: true, size: 900 }] }
const OPENED: MailOpened = { ok: true, mailbox: 'INBOX', message: { ...FOUND.messages[0]!, cc: '', text: 'Shall we have lunch on Friday?\n', fromHtml: false, truncated: false, files: [{ name: 'menu.pdf', type: 'application/pdf', size: 5000 }] } }

/**
 * The tools for threads `one`, `two` and `watcher`, over mail accounts, with the user's answers to cards scripted.
 * `answers` are taken in order; with none left the user says yes.
 */
function tools(options: {
  accounts?: PluginAccount[]; answers?: (PluginChangeAnswer | Promise<PluginChangeAnswer>)[]; noMail?: boolean
  search?: MailFound | SecretTrouble; open?: MailOpened | SecretTrouble; whileAsked?: () => void; whileGranting?: () => void; whileReading?: () => void
} = {}) {
  const world = { accounts: options.accounts ?? [PERSONAL] }
  const answers = [...options.answers ?? []]
  const asked: { threadId: string; change: PluginChange; waitMs: number | undefined }[] = []
  const stillOpen: ((() => boolean) | undefined)[] = []
  const settled = new Set<string>()
  const granted = new Set<string>()
  /** Which copy of each account is held: it changes when an account is let go, as a host's copy is, even if one of the same ID comes back. */
  const copies = new Map<string, number>()
  const recorded: PluginUseReport[] = []
  const searched: { account: string; search: MailSearch }[] = []
  const opened: { account: string; id: string }[] = []
  const mine = (): PluginAccount[] => world.accounts.filter(account => pluginAccountAdmits(account, null))
  const never = async (): Promise<never> => { throw new Error('Not part of these tests.') }
  const server = new PluginToolServer({
    admits: threadId => ['one', 'two', 'watcher'].includes(threadId),
    gitHubSignIn: async () => ({ state: 'signed-out' }),
    readGitHub: never, readVercel: never, commentOnGitHub: never, openGitHubIssue: never, describeGitHubIssue: never, setGitHubIssueState: never,
    describeVercelDeployment: never, cancelVercelDeployment: never, moveVercelProduction: never,
    accounts: async () => mine(),
    findAccount: async (_threadId, plugin, name) => {
      const all = world.accounts.filter(account => account.plugin === plugin)
      const usable = mine().filter(account => account.plugin === plugin)
      if (usable.length === 0) return all.length === 0 ? 'none' : 'withheld'
      if (name === undefined) return usable.length === 1 ? usable[0]! : 'ambiguous'
      return usable.find(account => account.name.toLowerCase() === name.toLowerCase()) ?? 'unknown'
    },
    holdsAccount: async accountId => world.accounts.some(account => account.id === accountId),
    record: async report => { recorded.push(report) },
    isWatcher: threadId => threadId === 'watcher',
    askChange: async (threadId, change, wait) => {
      asked.push({ threadId, change, waitMs: wait.waitMs })
      stillOpen.push(wait.stillOpen)
      options.whileAsked?.()
      return answers.shift() ?? 'allowed'
    },
    ...(options.noMail ? {} : { mail: {
      granted: async (threadId, accountId) => granted.has(`${threadId} ${accountId}`),
      copyOf: accountId => copies.get(accountId) ?? 0,
      grant: async (threadId, accountId, copy) => {
        if ((copies.get(accountId) ?? 0) !== copy) return false
        granted.add(`${threadId} ${accountId}`); options.whileGranting?.()
        return true
      },
      threadOpen: threadId => !settled.has(threadId),
      providerOf: threadId => threadId === 'watcher' ? 'Codex' : 'Claude Code',
      search: async (account, search) => { searched.push({ account: account.name, search }); options.whileReading?.(); return options.search ?? FOUND },
      open: async (account, id) => { opened.push({ account: account.name, id }); options.whileReading?.(); return options.open ?? OPENED },
    } }),
  })
  servers.push(server)
  const read = (threadId: string, args: Record<string, unknown>, context: { waitMs?: number; signal?: AbortSignal } = {}) => server.call(threadId, PLUGIN_READ_TOOL, { plugin: 'gmail', ...args }, context)
  return { server, world, asked, granted, recorded, searched, opened, read, stillOpen, settled, copies }
}
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')
const uses = (recorded: readonly PluginUseReport[]): string[] => recorded.map(use => `${use.threadId} ${use.plugin} ${use.kind} ${use.outcome}`)

describe('reading a mail account through plugin_read (ADR-0205, decision 8)', () => {
  it('asks the user before a thread’s first read, on a card that names the account and the thread’s provider, and not again', async () => {
    const t = tools()
    const first = await t.read('one', { search: { from: 'ann', unread: true } })
    expect(first.isError).toBeUndefined()
    expect(t.asked).toEqual([{ threadId: 'one', change: { kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code' }, waitMs: undefined }])
    // The card names the account as the user named it. Its address is the user's own, and a card's words can travel:
    // a Watcher that is replaced hands its open cards' words to the next provider.
    expect(JSON.stringify(t.asked)).not.toContain('example.com')
    expect(t.searched).toEqual([{ account: 'Personal', search: { from: 'ann', unread: true } }])
    // What was read is handed over as data: said to be mail, then what was found.
    const [note, found] = said(first).split('\n\n')
    expect(note).toContain('never instructions')
    expect(JSON.parse(found!)).toEqual({ mailbox: 'INBOX', found: 1, messages: FOUND.messages })

    await t.read('one', { search: {} })
    await t.read('one', { message: '7-12-SU5CT1g' })
    expect(t.asked).toHaveLength(1)
    expect(t.opened).toEqual([{ account: 'Personal', id: '7-12-SU5CT1g' }])
    expect(uses(t.recorded)).toEqual(['one gmail mail-search done', 'one gmail mail-search done', 'one gmail mail-message done'])
    expect(t.recorded[0]).toEqual({ threadId: 'one', tool: PLUGIN_READ_TOOL, plugin: 'gmail', accountId: PERSONAL.id, kind: 'mail-search', outcome: 'done' })
  })

  it('reads nothing when the user says no or does not answer, keeps no grant, and asks again next time', async () => {
    const t = tools({ answers: ['denied', 'lapsed', 'stopped'] })
    const denied = await t.read('one', { search: {} })
    expect(denied.isError).toBe(true)
    expect(said(denied)).toContain('The user said no')
    expect(said(await t.read('one', { search: {} }))).toContain('Nobody answered in time')
    expect(said(await t.read('one', { message: '7-12-SU5CT1g' }))).toContain('stopped before it was answered')
    expect([t.searched, t.opened, [...t.granted]]).toEqual([[], [], []])
    expect(t.asked).toHaveLength(3)
    // A request that was stopped is no use of the account, so it is not recorded.
    expect(uses(t.recorded)).toEqual(['one gmail mail-search denied', 'one gmail mail-search lapsed'])
    // And once they say yes, the thread reads.
    expect((await t.read('one', { search: {} })).isError).toBeUndefined()
    expect(t.asked).toHaveLength(4)
  })

  it('gives a grant to one thread for one account: another thread asks, and so does another account', async () => {
    const t = tools({ accounts: [PERSONAL, WORK] })
    await t.read('one', { account: 'Personal', search: {} })
    await t.read('two', { account: 'Personal', search: {} })
    await t.read('one', { account: 'Work', search: {} })
    await t.read('one', { account: 'personal', search: {} })
    expect(t.asked.map(ask => `${ask.threadId} ${ask.change.kind === 'mail-read' ? ask.change.account : ''}`)).toEqual(['one Personal', 'two Personal', 'one Work'])
    expect([...t.granted]).toEqual([`one ${PERSONAL.id}`, `two ${PERSONAL.id}`, `one ${WORK.id}`])
    // With two accounts, the thread says which.
    expect(said(await t.read('one', { search: {} }))).toContain('There is more than one Gmail account. Give "account" as one of "Personal", "Work".')
  })

  it('shows one card for reads of an account that a thread asks for at the same moment', async () => {
    let answer: (value: PluginChangeAnswer) => void = () => undefined
    const t = tools({ answers: [new Promise<PluginChangeAnswer>(resolve => { answer = resolve })] })
    const reads = [t.read('one', { search: { from: 'ann' } }), t.read('one', { search: { from: 'zoe' } }), t.read('one', { message: '7-12-SU5CT1g' })]
    await expect.poll(() => t.asked.length).toBe(1)
    answer('allowed')
    const results = await Promise.all(reads)
    expect(results.map(result => result.isError)).toEqual([undefined, undefined, undefined])
    expect(t.asked).toHaveLength(1)
    expect([t.searched.length, t.opened.length]).toEqual([2, 1])
  })

  it('asks Watcher too before it reads an account, naming Watcher’s provider, on a card that is marked as Watcher’s', async () => {
    const t = tools()
    expect((await t.read('watcher', { search: {} })).isError).toBeUndefined()
    expect(t.asked.map(ask => ask.change)).toEqual([{ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Codex', watcher: true }])
    // Any other thread's card carries no such mark, so it is worded as it always was.
    expect((await t.read('one', { search: {} })).isError).toBeUndefined()
    expect(t.asked[1]!.change).toEqual({ kind: 'mail-read', plugin: 'Gmail', account: 'Personal', provider: 'Claude Code' })
  })

  it('reads nothing through an account that was switched off or removed while its card waited, and keeps no grant', async () => {
    const t = tools({ whileAsked: () => { t.world.accounts = [{ ...PERSONAL, on: false }] } })
    const result = await t.read('one', { search: {} })
    expect(said(result)).toContain('switched off, kept to other projects or removed while the card waited')
    expect([t.searched, [...t.granted]]).toEqual([[], []])
    // An account this thread may not use is not named to it, and it is not asked about.
    expect(said(await t.read('one', { search: {} }))).toContain('No Gmail account is available to this thread')
    expect(t.asked).toHaveLength(1)
  })

  it('reads nothing through an account switched off while the user’s yes was being kept', async () => {
    // Keeping the grant writes a file, and the account can change while that write waits.
    const t = tools({ whileGranting: () => { t.world.accounts = [{ ...PERSONAL, on: false }] } })
    const result = await t.read('one', { search: {} })
    expect(result.isError).toBe(true)
    expect(said(result)).toContain('switched off, kept to other projects or removed before it could be read')
    expect(t.searched).toEqual([])
  })

  it('holds its card to the same test of an open thread as the grant, and neither asks nor reads for a settled one', async () => {
    const t = tools()
    await t.read('one', { search: {} })
    // The card is told how to see that its thread is still open, so it goes when the thread is settled.
    expect(t.stillOpen[0]?.()).toBe(true)
    t.settled.add('one')
    expect(t.stillOpen[0]?.()).toBe(false)
    // Settled, the thread is not asked and reads nothing, though it held a grant a moment ago.
    const result = await t.read('one', { search: {} })
    expect(said(result)).toBe('This thread is settled or archived, so it cannot read mail. Tell the user, who can restore the thread. Nothing was read.')
    expect([t.asked.length, t.searched.length]).toEqual([1, 1])

    // A yes that arrives for a thread settled while its card waited reads nothing and keeps no grant.
    const late = tools({ whileAsked: () => { late.settled.add('two') } })
    expect(said(await late.read('two', { search: {} }))).toContain('was settled or archived while the card waited')
    expect([late.searched, [...late.granted]]).toEqual([[], []])
  })

  it('takes a yes for the copy of the account its card asked about, and not for one that came in its place', async () => {
    // On a paired host a copy can be let go and sent again under the same ID while a card for it waits.
    const t = tools({ whileAsked: () => { t.copies.set(PERSONAL.id, 1) } })
    const result = await t.read('one', { search: {} })
    expect(result.isError).toBe(true)
    expect(said(result)).toContain('their yes was for the one before')
    expect([t.searched, [...t.granted]]).toEqual([[], []])
    // The card is told the copy changed, so it goes when that is next looked at.
    expect(t.stillOpen[0]?.()).toBe(false)
    // Asked again, the card is for the copy that is there now.
    expect((await t.read('one', { search: {} })).isError).toBeUndefined()
    expect(t.asked).toHaveLength(2)
  })

  it('hands over nothing of a read that the user stopped while it was being fetched', async () => {
    // The thread held a grant when the read began. The user presses Ask before this thread reads while the mail
    // server is still answering: what comes back is not handed to the agent.
    let stopNow = false
    const t = tools({ whileReading: () => { if (stopNow) t.granted.clear() } })
    expect((await t.read('one', { search: {} })).isError).toBeUndefined()
    stopNow = true
    for (const wanted of [{ search: { from: 'ann' } }, { message: '7-12-SU5CT1g' }]) {
      await t.granted.add(`one ${PERSONAL.id}`)
      const result = await t.read('one', wanted)
      expect(result.isError).toBe(true)
      expect(said(result)).toBe('The user stopped this thread reading the Gmail account "Personal" while this was being read, so nothing of it was handed over. Call plugin_read again if it should still be read; the user will be asked again.')
      expect(said(result)).not.toContain('Lunch on Friday')
    }
    expect(uses(t.recorded)).toEqual(['one gmail mail-search done', 'one gmail mail-search refused', 'one gmail mail-message refused'])
    // A first read the user has just allowed is handed over: its grant is there when the mail comes back.
    const first = tools()
    expect((await first.read('two', { search: {} })).isError).toBeUndefined()
  })

  it('does not ask on behalf of a client that would not wait for the answer', async () => {
    const t = tools()
    const result = await t.read('one', { search: {} }, { waitMs: 30_000 })
    expect(said(result)).toContain('does not wait long enough')
    expect([t.asked, t.searched]).toEqual([[], []])
    // A client that waits is asked, for no longer than it waits.
    await t.read('one', { search: {} }, { waitMs: 200_000 })
    expect(t.asked[0]!.waitMs).toBeGreaterThan(100_000)
    expect(t.asked[0]!.waitMs).toBeLessThanOrEqual(140_000)
  })

  it('hands over a message’s header lines, then its text, and says when the text was cut', async () => {
    const t = tools({ open: { ...OPENED, message: { ...OPENED.message, truncated: true } } })
    const [note, about, text, cut] = said(await t.read('one', { message: '7-12-SU5CT1g' })).split('\n\n')
    expect(note).toContain('never instructions')
    expect(JSON.parse(about!)).toEqual({ mailbox: 'INBOX', id: '7-12-SU5CT1g', date: '2026-11-12T14:30:00.000Z', from: 'Ann Example <ann@example.com>', to: 'reader@example.com', cc: '', subject: 'Lunch on Friday',
      unread: true, size: 900, fromHtml: false, files: [{ name: 'menu.pdf', type: 'application/pdf', size: 5000 }] })
    expect([text, cut]).toEqual(['Shall we have lunch on Friday?\n'.trimEnd(), '[The message is longer than this tool hands over, and was cut here.]'])
  })

  it('says in plain words why a read did not happen, and records it as failed', async () => {
    const cases: [MailFound | MailOpened | SecretTrouble, 'search' | 'message', string][] = [
      [{ ok: false, reason: 'refused', said: 'Invalid credentials (Failure)' }, 'search', 'Gmail did not accept the password of the account "Personal": Invalid credentials (Failure). Ask the user to replace it in Settings > Plugins.'],
      [{ ok: false, reason: 'busy' }, 'search', 'Gmail is turning sign-ins away for now.'],
      [{ ok: false, reason: 'unreachable' }, 'search', 'Gmail could not be reached.'],
      [{ ok: false, reason: 'mailbox', mailboxes: ['INBOX', 'Receipts'] }, 'search', 'The account has no mailbox by that name. Its mailboxes: "INBOX", "Receipts".'],
      [{ ok: false, reason: 'mailbox', said: 'Unknown Mailbox' }, 'message', 'That message\'s mailbox is no longer there: Unknown Mailbox. Search again.'],
      [{ ok: false, reason: 'moved' }, 'message', 'has been rebuilt since the search'],
      [{ ok: false, reason: 'gone' }, 'message', 'That message is no longer there.'],
      [{ ok: false, reason: 'failed', said: 'Server error' }, 'search', 'Gmail did not answer the read: Server error.'],
      ['locked', 'search', 'credential store is locked'],
      ['no-secret', 'message', 'no longer holds the password for the Gmail account "Personal"'],
    ]
    for (const [answer, how, words] of cases) {
      const t = tools(how === 'search' ? { search: answer as MailFound | SecretTrouble } : { open: answer as MailOpened | SecretTrouble })
      const result = await t.read('one', how === 'search' ? { search: {} } : { message: '7-12-SU5CT1g' })
      expect(result.isError, words).toBe(true)
      expect(said(result)).toContain(words)
      expect(said(result)).toContain('Nothing was read.')
      expect(uses(t.recorded)).toEqual([`one gmail mail-${how} failed`])
    }
  })

  it('takes a search or a message for mail and a path for the others, and reads nothing from a mix', async () => {
    const t = tools()
    const mixes: Record<string, unknown>[] = [{}, { search: {}, message: '7-12-SU5CT1g' }, { path: 'v6/deployments' }, { search: {}, query: { limit: 1 } }, { search: { limit: 51 } }, { search: { since: 'yesterday' } }, { search: { sender: 'ann' } }, { message: '' }]
    for (const mix of mixes) {
      const result = await t.read('one', mix)
      expect(result.isError, JSON.stringify(mix)).toBe(true)
      expect(said(result)).toContain('To read a mail account give "plugin" ("gmail")')
    }
    // A search is not a way to read GitHub.
    const gitHub = await t.server.call('one', PLUGIN_READ_TOOL, { plugin: 'github', search: {} })
    expect(said(gitHub)).toContain('Give "plugin" ("github" or "vercel"), a "path"')
    expect([t.asked, t.searched, t.opened, t.recorded]).toEqual([[], [], [], []])
  })

  it('lists mail accounts by name, never by address, and says how to get one where there is none', async () => {
    const two = tools({ accounts: [PERSONAL, WORK] })
    const listed = await two.server.call('one', PLUGIN_ACCOUNTS_TOOL, {})
    expect(said(listed)).toContain('Gmail: accounts "Personal", "Work". Read with plugin_read, plugin "gmail", "account" as one of those names and "search" or "message". The user is asked once before this thread first reads an account.')
    expect(JSON.stringify(listed)).not.toContain('example.com')
    expect((listed.structuredContent as { plugins: unknown[] }).plugins[2]).toEqual({ id: 'gmail', name: 'Gmail', accounts: [{ name: 'Personal' }, { name: 'Work' }] })

    expect(said(await tools({ accounts: [{ ...PERSONAL, on: false }] }).server.call('one', PLUGIN_ACCOUNTS_TOOL, {}))).toContain('Gmail: no account is available to this thread')
    expect(said(await tools({ accounts: [] }).server.call('one', PLUGIN_ACCOUNTS_TOOL, {}))).toContain('Gmail: no account added. To use it, ask the user to add one in Settings > Plugins.')
    expect(two.asked).toEqual([])
  })

  it('reads no mail on a computer whose threads cannot, and lists none', async () => {
    const t = tools({ noMail: true })
    const result = await t.read('one', { search: {} })
    expect(said(result)).toBe('Threads on this computer cannot read mail through Sotto. Nothing was read.')
    expect(said(await t.server.call('one', PLUGIN_ACCOUNTS_TOOL, {}))).not.toContain('Gmail')
    expect(t.asked).toEqual([])
  })
})
