// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { wordPluginChangeInEnglish } from '../../../../src/main/plugins/changeWordsPlain'
import type { MailFound } from '../../../../src/main/plugins/mail/read'
import { MailGrants, mailThreadOpen } from '../../../../src/main/plugins/mailGrants'
import { PluginChangeRequests } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer } from '../../../../src/main/plugins/pluginTools'
import { PLUGIN_READ_TOOL, type PluginAccount } from '../../../../src/shared/plugins'

const closing: (() => unknown)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

/** A made-up account: nothing here is a real address. */
const PERSONAL: PluginAccount = { id: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal', address: 'reader@example.com', savedAt: '2026-11-13T08:00:00.000Z', signedInAs: null, on: true, projects: null }
const FOUND: MailFound = { ok: true, mailbox: 'INBOX', found: 0, messages: [] }
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')

/**
 * The mail grants, the cards and the tools joined as the desktop joins them, over one thread the user can settle
 * and restore. The cards' own test of a closed thread does not count the user's Settle, as the coordinator's does not.
 */
async function desk() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-mail-settle-'))
  const thread = { id: 'one', projectId: 'project-one', workspaceSettledAt: null as string | null }
  const snapshot = { threads: [thread], projects: [{ id: 'project-one' }] }
  const grants = new MailGrants(directory, { open: threadId => mailThreadOpen(snapshot, threadId) })
  const cards = new PluginChangeRequests({ open: () => true, noticed: () => { grants.noticed() } })
  let searched = 0
  const never = async (): Promise<never> => { throw new Error('Not part of these tests.') }
  const tools = new PluginToolServer({
    admits: () => true, isWatcher: () => false, gitHubSignIn: async () => ({ state: 'signed-out' }), record: async () => undefined,
    readGitHub: never, readVercel: never, commentOnGitHub: never, openGitHubIssue: never, describeGitHubIssue: never, setGitHubIssueState: never,
    describeVercelDeployment: never, cancelVercelDeployment: never, moveVercelProduction: never,
    accounts: async () => [PERSONAL], findAccount: async () => PERSONAL, holdsAccount: async () => true,
    askChange: (threadId, change, wait) => cards.ask(threadId, wordPluginChangeInEnglish(change), wait),
    mail: {
      granted: (threadId, accountId) => grants.has(threadId, accountId), grant: (threadId, accountId, copy) => grants.grant(threadId, accountId, copy), copyOf: accountId => grants.generation(accountId),
      threadOpen: threadId => grants.open(threadId), providerOf: () => 'Claude Code',
      search: async () => { searched += 1; return FOUND }, open: never,
    },
  })
  closing.push(() => rm(directory, { recursive: true, force: true }), () => { grants.close(); cards.close() }, () => tools.close())
  const read = () => tools.call('one', PLUGIN_READ_TOOL, { plugin: 'gmail', search: {} })
  const card = (): string | undefined => cards.requests().get('one')?.[0]?.id
  const settle = (): void => { thread.workspaceSettledAt = '2026-11-13T10:00:00.000Z'; cards.stopClosed() }
  const restore = (): void => { thread.workspaceSettledAt = null }
  return { grants, cards, read, card, settle, restore, searched: () => searched }
}

it('takes the mail card down when the user settles its thread, and reads nothing for it', async () => {
  const d = await desk()
  const reading = d.read()
  await expect.poll(d.card).toBeDefined()
  d.settle()
  // The card goes with the thread, as the grant would: there is nothing left to say yes to.
  expect(d.card()).toBeUndefined()
  const result = await reading
  expect(result.isError).toBe(true)
  expect(said(result)).toContain('Nothing was read.')
  expect([d.searched(), await d.grants.list()]).toEqual([0, []])
})

it('asks nothing of the user from a settled thread whose work goes on, however often it tries to read', async () => {
  const d = await desk()
  d.settle()
  for (let tries = 0; tries < 3; tries += 1) {
    const result = await d.read()
    expect(said(result)).toBe('This thread is settled or archived, so it cannot read mail. Tell the user, who can restore the thread. Nothing was read.')
  }
  expect([d.card(), d.searched(), await d.grants.list()]).toEqual([undefined, 0, []])
})

it('reads nothing on a yes that is given after the thread was settled, and keeps no grant', async () => {
  const d = await desk()
  const reading = d.read()
  await expect.poll(d.card).toBeDefined()
  const id = d.card()!
  // Settled a moment before the answer, before anything has looked at the thread again.
  d.restore()
  const settledNow = { at: false }
  const grantsOpen = d.grants.open.bind(d.grants)
  d.grants.open = threadId => !settledNow.at && grantsOpen(threadId)
  settledNow.at = true
  d.cards.answer('one', id, true)
  const result = await reading
  expect(result.isError).toBe(true)
  expect(said(result)).toContain('settled')
  expect([d.searched(), await d.grants.list()]).toEqual([0, []])
})

it('asks again once the thread is restored, and then reads on that yes', async () => {
  const d = await desk()
  d.settle()
  await d.read()
  d.restore()
  const reading = d.read()
  await expect.poll(d.card).toBeDefined()
  d.cards.answer('one', d.card()!, true)
  expect((await reading).isError).toBeUndefined()
  expect(d.searched()).toBe(1)
  // And the grant holds: the next read does not ask.
  expect((await d.read()).isError).toBeUndefined()
  expect([d.card(), d.searched()]).toEqual([undefined, 2])
})
