// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { MailDraft } from '../../../../src/main/plugins/mail/compose'
import type { MailSendFailure, MailSent } from '../../../../src/main/plugins/mail/send'
import type { PluginChangeAnswer } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer, type SecretTrouble } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { MAIL_SEND_TOOL, PLUGIN_ACCOUNTS_TOOL, pluginAccountAdmits, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'

const servers: PluginToolServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

/** A made-up account: nothing here is a real address. */
const PERSONAL: PluginAccount = { id: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal', address: 'reader@example.com', savedAt: '2026-11-14T08:00:00.000Z', signedInAs: null, on: true, projects: null }
const EMAIL = { plugin: 'gmail', to: ['ann@example.com', 'ben@example.org'], cc: ['cara@example.com'], bcc: ['dan@example.net'], subject: 'October numbers by Friday', text: 'Hello Ann,\n\nThe numbers for October need to reach us by Friday.\n' }
const SENT: MailSent = { ok: true, recipients: 4, messageId: '<made-up@example.com>' }

/**
 * The tools for threads `one` and `watcher`, over one mail account, with the user's answers to cards scripted.
 * `answers` are taken in order; with none left the user says yes. The thread already holds a mail grant, which must
 * make no difference to a send.
 */
function tools(options: { answers?: PluginChangeAnswer[]; sent?: MailSent | MailSendFailure | SecretTrouble; trouble?: SecretTrouble; noMail?: boolean; whileAsked?: () => void } = {}) {
  const world = { accounts: [PERSONAL] }
  const answers = [...options.answers ?? []]
  const asked: { threadId: string; change: PluginChange }[] = []
  const recorded: PluginUseReport[] = []
  const sends: { account: string; draft: MailDraft }[] = []
  const mine = (): PluginAccount[] => world.accounts.filter(account => pluginAccountAdmits(account, null))
  const never = async (): Promise<never> => { throw new Error('Not part of these tests.') }
  const server = new PluginToolServer({
    admits: threadId => ['one', 'watcher'].includes(threadId),
    gitHubSignIn: async () => ({ state: 'signed-out' }),
    readGitHub: never, readVercel: never, commentOnGitHub: never, openGitHubIssue: never, describeGitHubIssue: never, setGitHubIssueState: never,
    describeVercelDeployment: never, cancelVercelDeployment: never, moveVercelProduction: never,
    accounts: async () => mine(),
    findAccount: async (_threadId, plugin, name) => {
      const usable = mine().filter(account => account.plugin === plugin)
      if (usable.length === 0) return world.accounts.length === 0 ? 'none' : 'withheld'
      return name === undefined ? usable[0]! : usable.find(account => account.name === name) ?? 'unknown'
    },
    holdsAccount: async accountId => world.accounts.some(account => account.id === accountId),
    record: async report => { recorded.push(report) },
    isWatcher: threadId => threadId === 'watcher',
    askChange: async (threadId, change) => {
      asked.push({ threadId, change })
      options.whileAsked?.()
      return answers.shift() ?? 'allowed'
    },
    ...(options.noMail ? {} : { mail: {
      granted: async () => true, copyOf: () => 0, grant: async () => true, threadOpen: () => true, providerOf: () => 'Claude Code',
      search: never, open: never,
      sendTrouble: () => options.trouble ?? null,
      send: async (account, draft) => { sends.push({ account: account.name, draft }); return options.sent ?? SENT },
    } }),
  })
  servers.push(server)
  const send = (threadId: string, args: Record<string, unknown> = EMAIL) => server.call(threadId, MAIL_SEND_TOOL, args)
  return { server, world, asked, recorded, sends, send }
}
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')
const uses = (recorded: readonly PluginUseReport[]): string[] => recorded.map(use => `${use.threadId} ${use.tool} ${use.kind} ${use.outcome}`)

describe('sending an email through mail_send (ADR-0205, slice 9)', () => {
  it('asks the user every time, even of a thread that may read the account, and sends only after their yes', async () => {
    const t = tools()
    const first = await t.send('one')
    expect(first.isError).toBeUndefined()
    expect(said(first)).toBe('The user allowed it. Sent from the Gmail account "Personal" to 4 addresses.')
    // The card is given everything that is sent, the Bcc too, and the account by its name, never its address.
    expect(t.asked).toEqual([{ threadId: 'one', change: { kind: 'mail-send', plugin: 'Gmail', account: 'Personal', to: EMAIL.to, cc: EMAIL.cc, bcc: EMAIL.bcc, subject: EMAIL.subject, text: EMAIL.text } }])
    expect(JSON.stringify(t.asked)).not.toContain('reader@example.com')
    expect(t.sends).toEqual([{ account: 'Personal', draft: { to: EMAIL.to, cc: EMAIL.cc, bcc: EMAIL.bcc, subject: EMAIL.subject, text: EMAIL.text } }])
    // A second email asks again: no yes covers the next one.
    await t.send('one', { ...EMAIL, cc: undefined, bcc: undefined, to: ['ann@example.com'] })
    expect(t.asked).toHaveLength(2)
    expect(t.sends[1]!.draft).toEqual({ to: ['ann@example.com'], cc: [], bcc: [], subject: EMAIL.subject, text: EMAIL.text })
    expect(uses(t.recorded)).toEqual(['one mail_send mail-send done', 'one mail_send mail-send done'])
    expect(t.recorded[0]).toEqual({ threadId: 'one', tool: MAIL_SEND_TOOL, plugin: 'gmail', accountId: PERSONAL.id, kind: 'mail-send', outcome: 'done' })
  })

  it('sends nothing when the user says no, or nobody answers', async () => {
    const t = tools({ answers: ['denied', 'lapsed', 'stopped'] })
    expect(said(await t.send('one'))).toBe('The user said no. Nothing was sent. Do not ask again unless they tell you to.')
    expect(said(await t.send('one'))).toContain('Nobody answered in time, so the request lapsed. Nothing was sent.')
    expect(said(await t.send('one'))).toBe('The request was stopped before it was answered. Nothing was sent.')
    expect(t.sends).toEqual([])
    expect(uses(t.recorded)).toEqual(['one mail_send mail-send denied', 'one mail_send mail-send lapsed'])
  })

  it('is not offered to Watcher, and sends nothing for it', async () => {
    const t = tools()
    const offered = async (threadId: string): Promise<string[]> => {
      const endpoint = (await t.server.mcpServer(threadId))!
      const listed = await (await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json() as { result: { tools: { name: string }[] } }
      return listed.result.tools.map(tool => tool.name)
    }
    expect(await offered('one')).toContain(MAIL_SEND_TOOL)
    expect(await offered('watcher')).not.toContain(MAIL_SEND_TOOL)
    const watcher = await t.send('watcher')
    expect(watcher.isError).toBe(true)
    expect(said(watcher)).toContain('Watcher reads from plugins and changes nothing through them.')
    expect([t.asked, t.sends]).toEqual([[], []])
  })

  it('refuses an email it cannot send before anyone is asked', async () => {
    const t = tools()
    // 101 people, To and Cc together: each line alone is within the limit.
    const many = Array.from({ length: 51 }, (_value, index) => `person${index}@example.com`)
    const more = Array.from({ length: 50 }, (_value, index) => `other${index}@example.com`)
    for (const [args, reason] of [
      [{ ...EMAIL, to: ['Ann <ann@example.com>'] }, 'one plain address'],
      [{ ...EMAIL, to: many, cc: more, bcc: [] }, 'at most 100 addresses'],
      [{ ...EMAIL, subject: 'One\r\nBcc: someone@example.com' }, 'one line'],
      [{ ...EMAIL, subject: ' ' }, 'subject'],
      [{ ...EMAIL, text: '' }, 'some text'],
      [{ ...EMAIL, to: [] }, '"to"'],
      [{ ...EMAIL, html: '<p>Hi</p>' }, '"to"'],
    ] as const) {
      const result = await t.send('one', args)
      expect(result.isError, reason).toBe(true)
      expect(said(result), reason).toContain(reason)
      expect(said(result), reason).toContain('Nothing was sent.')
    }
    expect([t.asked, t.sends, t.recorded]).toEqual([[], [], []])
  })

  it('says a password it cannot read before the user is asked', async () => {
    const t = tools({ trouble: 'locked' })
    expect(said(await t.send('one'))).toContain('credential store is locked')
    expect([t.asked, t.sends]).toEqual([[], []])
    expect(said(await tools({ noMail: true }).send('one'))).toBe('Threads on this computer cannot send mail through Sotto. Nothing was sent.')
  })

  it('sends nothing for an account switched off or removed while the card waited', async () => {
    const off = tools({ whileAsked: () => { off.world.accounts = [{ ...PERSONAL, on: false }] } })
    expect(said(await off.send('one'))).toContain('switched off, kept to other projects or removed while the card waited. Nothing was sent.')
    expect(off.sends).toEqual([])
    expect(uses(off.recorded)).toEqual(['one mail_send mail-send failed'])
    // A removed account is forgotten, and gets no entry.
    const gone = tools({ whileAsked: () => { gone.world.accounts = [] } })
    await gone.send('one')
    expect([gone.sends, gone.recorded]).toEqual([[], []])
  })

  it('never says an email it cannot be sure of was not sent', async () => {
    const t = tools({ sent: { ok: false, reason: 'unsure' } })
    const unsure = await t.send('one')
    expect(said(unsure)).toBe('The user allowed it and the whole email was handed to Gmail, but its answer never came. Sotto cannot tell whether this was sent. Do not send it again; tell the user, who can look in Sent.')
    expect(said(unsure)).not.toContain('Nothing was sent')
    expect(uses(t.recorded)).toEqual(['one mail_send mail-send unsure'])
  })

  it('says which address the server turned away, and that nobody was sent it', async () => {
    const turned = await tools({ sent: { ok: false, reason: 'recipient', recipient: 'gone@example.com', said: '5.1.1 No such person' } }).send('one')
    expect(said(turned)).toBe('The user allowed it, but Gmail would not take mail for gone@example.com: 5.1.1 No such person, so nothing was sent to anyone.')
    const refused = await tools({ sent: { ok: false, reason: 'refused' } }).send('one')
    expect(said(refused)).toBe('The user allowed it, but Gmail did not accept the password of the account "Personal". Ask the user to replace it in Settings > Plugins. Nothing was sent.')
  })

  it('tells an agent of the account that it can send, and that each email asks', async () => {
    const t = tools()
    expect(said(await t.server.call('one', PLUGIN_ACCOUNTS_TOOL, {}))).toContain('Send an email with mail_send; the user is asked before each one.')
  })
})
