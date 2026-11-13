import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { PluginsSettings } from '../../../../../src/renderer/src/features/settings/PluginsSettings'
import type { GitHubSignIn, PluginAccount, PluginAccountResult, PluginAccountUpdate, PluginCopiesView, PluginCopySet, PluginHostSignIn, PluginProject, PluginsBridge, ShownPluginUse } from '../../../../../src/shared/plugins'
import { deferred } from '../../../../fixtures/deferred'

afterEach(cleanup)

const noUses = async (): Promise<ShownPluginUse[]> => []
/** A bridge with no other computer paired. */
const NO_COMPUTERS: PluginCopiesView = { copyNew: true, readable: true, computers: [], copies: [] }
const noCopies = {
  copies: async (): Promise<PluginCopiesView> => NO_COMPUTERS,
  setCopy: async (): Promise<PluginCopiesView> => NO_COMPUTERS,
  setCopyNew: async (): Promise<PluginCopiesView> => NO_COMPUTERS,
  onCopiesChanged: (): (() => void) => () => undefined,
  gitHubSignInElsewhere: async (): Promise<PluginHostSignIn[]> => [],
}
/** The account methods of a bridge with no accounts, for tests of GitHub's row. */
const noAccounts = {
  accounts: async (): Promise<PluginAccount[]> => [],
  addAccount: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  replaceSecret: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  removeAccount: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  updateAccount: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  projects: async (): Promise<PluginProject[]> => [],
  ...noCopies,
}
const answering = (...answers: readonly GitHubSignIn[]): { bridge: PluginsBridge; asked: () => number } => {
  let asked = 0
  return { bridge: { gitHubSignIn: async () => answers[Math.min(asked++, answers.length - 1)]!, recentUse: noUses, ...noAccounts }, asked: () => asked }
}
const use = (id: number, extra: Partial<ShownPluginUse>): ShownPluginUse => ({ id: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`, at: '2026-11-12T08:00:00.000Z',
  threadId: `thread-${id}`, plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done', threadTitle: 'Fix the preview build', ...extra })
const row = (): HTMLElement => screen.getByRole('button', { name: /^GitHub/u })

it('names who gh is signed in as on the folded row, and opens in place to say Sotto stores nothing', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'signed-in', login: 'example-user' }).bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
  expect(row()).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(row())
  expect(row()).toHaveAttribute('aria-expanded', 'true')
  expect(document.getElementById(row().getAttribute('aria-controls')!)).toHaveTextContent('Signed in as example-user through gh on this computer.')
  expect(screen.getByText('GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.')).toBeInTheDocument()
  // Find a setting lands on the row by its marker, whatever language the page is in.
  expect(document.querySelector('[data-setting="plugin-github"]')).toContainElement(row())
})

it('closes the open row on Escape from anywhere in it, and gives focus back to its header', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'signed-in', login: 'example-user' }).bridge} />) })
  fireEvent.click(row())
  const again = screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })
  again.focus()
  fireEvent.keyDown(again, { key: 'Escape' })
  expect(row()).toHaveAttribute('aria-expanded', 'false')
  expect(row()).toHaveFocus()
  // A folded row leaves Escape alone, for whatever holds the page.
  expect(fireEvent.keyDown(row(), { key: 'Escape' })).toBe(true)
})

it('shows the sign-in command when gh is signed out, and asks gh again on Check again', async () => {
  const gh = answering({ state: 'signed-out' }, { state: 'signed-in', login: 'example-user' })
  await act(async () => { render(<PluginsSettings bridge={gh.bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub Not signed in')
  fireEvent.click(row())
  expect(screen.getByText('gh auth login')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy the gh sign-in command' })).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(gh.asked()).toBe(2)
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
})

it('says when gh is not installed, and when it could not be asked, without calling either signed out', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'not-installed' }).bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub gh isn’t installed')
  fireEvent.click(row())
  expect(screen.getByText(/isn’t installed on this computer\. Install it from cli\.github\.com/u)).toBeInTheDocument()
  cleanup()
  const failing: PluginsBridge = { gitHubSignIn: async () => { throw new Error('spawn C:\\Users\\someone\\gh.exe EPERM') }, recentUse: noUses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={failing} />) })
  expect(row()).toHaveAccessibleName('GitHub Couldn’t check')
  fireEvent.click(row())
  expect(screen.getByText('Sotto couldn’t ask gh who is signed in. Nothing was changed. Press Check again.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('someone')
})

it('keeps focus on Check again while gh is asked, and takes no second press until it answers', async () => {
  const second = deferred<GitHubSignIn>()
  const gitHubSignIn = vi.fn<() => Promise<GitHubSignIn>>().mockResolvedValueOnce({ state: 'signed-out' }).mockReturnValueOnce(second.promise)
  await act(async () => { render(<PluginsSettings bridge={{ gitHubSignIn, recentUse: noUses, ...noAccounts }} />) })
  fireEvent.click(row())
  const again = screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })
  again.focus()
  fireEvent.click(again)
  expect(again).toHaveAttribute('aria-disabled', 'true')
  expect(again).toHaveFocus()
  fireEvent.click(again)
  expect(gitHubSignIn).toHaveBeenCalledTimes(2)
  await act(async () => { second.resolve({ state: 'signed-in', login: 'example-user' }) })
  expect(again).toHaveAttribute('aria-disabled', 'false')
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
})

it('shows a plugin’s newest uses: what was done and in which thread, and how a use ended', async () => {
  const uses = [
    use(1, {}),
    use(2, { kind: 'pull-requests', outcome: 'failed', threadTitle: 'Review the release' }),
    use(3, { kind: 'other', outcome: 'refused', threadTitle: null }),
  ]
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => uses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  expect(screen.getByText('A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. Reading never asks you, except that each thread asks once before it reads a mail account. A change, such as posting a comment, asks you first in its thread, each time.')).toBeInTheDocument()
  fireEvent.click(row())
  const items = within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')
  expect(items.map(item => item.querySelector('span')!.textContent)).toEqual([
    'Read issues in “Fix the preview build”',
    'Read pull requests in “Review the release” It failed.',
    'Read from GitHub in a thread that is gone Sotto refused it.',
  ])
  expect(items[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T08:00:00.000Z')
  expect(screen.getByText('Sotto records what was done and by which thread, never what was read or sent.')).toBeInTheDocument()
})

it('says when no thread has used a plugin yet, shows only the newest five, and reads the uses again on Check again', async () => {
  let asked = 0
  const many = Array.from({ length: 7 }, (_, index) => use(index + 1, { threadTitle: `Thread ${index + 1}` }))
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => asked++ === 0 ? [] : many, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.getByText('No thread has used GitHub yet.')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')).toHaveLength(5)
})

it('leaves Recent use out when the record could not be read, rather than saying nothing was used', async () => {
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => { throw new Error('EACCES') }, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.queryByRole('region', { name: 'Recent use' })).toBeNull()
  expect(screen.queryByText('No thread has used GitHub yet.')).toBeNull()
})

/** A made-up account and a made-up token: nothing here is a real credential. */
const work: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }
const TOKEN = 'made-up-vercel-token'
const vercelRow = (): HTMLElement => screen.getByRole('button', { name: /^Vercel/u })
function vercelBridge(start: readonly PluginAccount[], overrides: Partial<PluginsBridge> = {}): PluginsBridge {
  return { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: noUses, ...noAccounts, accounts: async () => [...start], ...overrides }
}

it('adds a Vercel account from its row: the token goes to main once and is not left in the page', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [work] }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  expect(vercelRow()).toHaveAccessibleName('Vercel Not added')
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  const form = screen.getByRole('form', { name: 'Add a Vercel account' })
  expect(within(form).getByLabelText('Name')).toHaveFocus()
  const submit = within(form).getByRole('button', { name: 'Add account' })
  expect(submit).toHaveAttribute('aria-disabled', 'true')
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Work ' } })
  const token = within(form).getByLabelText('Token')
  expect(token).toHaveAttribute('type', 'password')
  fireEvent.change(token, { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(submit) })
  expect(addAccount).toHaveBeenCalledWith({ plugin: 'vercel', name: 'Work', secret: TOKEN })
  expect(screen.queryByRole('form', { name: 'Add a Vercel account' })).toBeNull()
  expect(vercelRow()).toHaveAccessibleName('Vercel Work')
  const card = screen.getByRole('region', { name: 'Vercel account Work' })
  expect(card).toHaveTextContent(/Signed in to Vercel as example-user\. Token saved November 1[12]\./u)
  expect(document.body.innerHTML).not.toContain(TOKEN)
})

it('says what happened when Vercel refuses a token, that nothing was saved, and what to do', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'refused' }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add account' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('Vercel did not accept this token. Nothing was saved. Make a new token at vercel.com/account/tokens and paste it here.')
  // The form stays, so the name need not be typed again, but the refused token is not kept in the page.
  expect(screen.getByLabelText('Name')).toHaveValue('Work')
  expect(screen.getByLabelText('Token')).toHaveValue('')
  expect(document.body.innerHTML).not.toContain(TOKEN)
  // Escape cancels the form without closing the row, and focus goes back to the button that opened it.
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
  expect(screen.queryByRole('form', { name: 'Add a Vercel account' })).toBeNull()
  expect(vercelRow()).toHaveAttribute('aria-expanded', 'true')
})

it('replaces an account’s token only on its own form, and keeps the saved one when the new one is refused', async () => {
  let answer: PluginAccountResult = { ok: false, problem: 'refused' }
  const replaceSecret = vi.fn(async (): Promise<PluginAccountResult> => answer)
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work], { replaceSecret })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Replace the token for Work' }))
  fireEvent.change(screen.getByLabelText('New token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(replaceSecret).toHaveBeenCalledWith({ id: work.id, secret: TOKEN })
  expect(screen.getByRole('alert')).toHaveTextContent('Vercel did not accept this token. The token already saved was kept. Make a new token at vercel.com/account/tokens and paste it here.')
  expect(screen.getByLabelText('New token')).toHaveValue('')
  answer = { ok: true, accounts: [{ ...work, savedAt: '2026-11-13T08:00:00.000Z' }] }
  fireEvent.change(screen.getByLabelText('New token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(screen.queryByLabelText('New token')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.body.innerHTML).not.toContain(TOKEN)
})

it('asks before removing an account, saying what is deleted and that nothing changes at Vercel', async () => {
  const removeAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [] }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work], { removeAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Remove the Vercel account Work' }))
  const asking = screen.getByRole('group', { name: 'Remove the Vercel account Work' })
  expect(asking).toHaveTextContent('Remove Work? Its token is deleted from this computer, and threads lose the account at once. Nothing changes at Vercel.')
  expect(removeAccount).not.toHaveBeenCalled()
  // Keep it leaves the account as it was.
  fireEvent.click(within(asking).getByRole('button', { name: 'Keep it' }))
  expect(screen.getByRole('region', { name: 'Vercel account Work' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove the Vercel account Work' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove account' })) })
  expect(removeAccount).toHaveBeenCalledWith({ id: work.id })
  expect(screen.queryByRole('region', { name: 'Vercel account Work' })).toBeNull()
  expect(vercelRow()).toHaveAccessibleName('Vercel Not added')
  // The account's buttons are gone with it: focus goes to the button that adds one.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add a Vercel account' })).toHaveFocus())
})

it('lists each account’s own recent use, and names several accounts on the folded row', async () => {
  const personal: PluginAccount = { ...work, id: '22222222-2222-4222-8222-000000000002', name: 'Personal', signedInAs: null }
  const uses = [use(1, { plugin: 'vercel', accountId: work.id, kind: 'deployments' }), use(2, { plugin: 'vercel', accountId: personal.id, kind: 'logs', threadTitle: 'Fix the preview build' })]
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work, personal], { recentUse: async () => uses })} />) })
  expect(vercelRow()).toHaveAccessibleName('Vercel 2 accounts: Work, Personal')
  fireEvent.click(vercelRow())
  expect(within(screen.getByRole('region', { name: 'Vercel account Work' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual(['Read deployments in “Fix the preview build”'])
  expect(within(screen.getByRole('region', { name: 'Vercel account Personal' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual(['Read a build log in “Fix the preview build”'])
  expect(screen.getByRole('button', { name: 'Add another Vercel account' })).toBeInTheDocument()
})

it('does not let a token that is being checked be cancelled, since it is saved or refused whatever the form does', async () => {
  const checking = deferred<PluginAccountResult>()
  const addAccount = vi.fn(() => checking.promise)
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } })
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  expect(cancel).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(cancel)
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
  // The form is still there, and so is the row.
  expect(screen.getByRole('form', { name: 'Add a Vercel account' })).toBeInTheDocument()
  expect(vercelRow()).toHaveAttribute('aria-expanded', 'true')
  await act(async () => { checking.resolve({ ok: true, accounts: [work] }) })
  expect(screen.getByRole('region', { name: 'Vercel account Work' })).toBeInTheDocument()
})

it('says Vercel is turning requests away, not that the connection is lost, when a token could not be checked for that reason', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'busy' }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add account' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('Vercel is turning requests away for now, so the token could not be checked. Nothing was saved. Wait a minute, then try again.')
})

it('says of a change what was done or only asked for, and how the user answered', async () => {
  const uses = [
    use(1, { tool: 'github_comment', kind: 'comment', outcome: 'done' }),
    use(2, { tool: 'github_comment', kind: 'comment', outcome: 'denied' }),
    use(3, { tool: 'github_comment', kind: 'comment', outcome: 'lapsed' }),
    use(4, { tool: 'github_comment', kind: 'comment', outcome: 'failed' }),
  ]
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => uses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual([
    'Posted a comment in “Fix the preview build” You allowed it.',
    'Asked to post a comment in “Fix the preview build” You said no.',
    'Asked to post a comment in “Fix the preview build” Nobody answered in time.',
    'Asked to post a comment in “Fix the preview build” You allowed it, and it failed.',
  ])
})

it('says of each kind of change what was done, and what was only asked for', async () => {
  const uses = [
    use(1, { tool: 'github_open_issue', kind: 'issue-open', outcome: 'done' }),
    use(2, { tool: 'github_close_issue', kind: 'issue-close', outcome: 'done' }),
    use(3, { tool: 'github_reopen_issue', kind: 'issue-reopen', outcome: 'denied' }),
    use(4, { tool: 'vercel_promote_deployment', kind: 'deployment-promote', outcome: 'done' }),
    use(5, { tool: 'vercel_rollback_production', kind: 'deployment-rollback', outcome: 'lapsed' }),
  ]
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => uses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual([
    'Opened an issue in “Fix the preview build” You allowed it.',
    'Closed an issue in “Fix the preview build” You allowed it.',
    'Asked to reopen an issue in “Fix the preview build” You said no.',
    'Promoted a deployment to production in “Fix the preview build” You allowed it.',
    'Asked to roll production back in “Fix the preview build” Nobody answered in time.',
  ])
})

/** A bridge that keeps what the page asks of an account's switch and projects, and answers with the account so changed. */
function threadsBridge(start: PluginAccount, projects: readonly PluginProject[] = [{ id: 'p-sotto', title: 'Sotto', settled: false }, { id: 'p-site', title: 'Lumen shop', settled: false }, { id: 'p-old', title: 'Old site', settled: true }]) {
  let account = start
  const updates: PluginAccountUpdate[] = []
  const bridge = vercelBridge([start], {
    projects: async () => [...projects],
    updateAccount: async request => {
      updates.push(request)
      account = { ...account, ...(request.on === undefined ? {} : { on: request.on }), ...(request.projects === undefined ? {} : { projects: request.projects }) }
      return { ok: true, accounts: [account] }
    },
  })
  return { bridge, updates }
}
const chips = (): { name: string; pressed: boolean }[] =>
  within(screen.getByRole('group', { name: 'Projects whose threads may use Work' })).getAllByRole('button').map(chip => ({ name: chip.textContent, pressed: chip.getAttribute('aria-pressed') === 'true' }))

it('lets an account be switched off for every thread, and says so on the folded row', async () => {
  const { bridge, updates } = threadsBridge(work)
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  const toggle = await screen.findByRole('switch', { name: 'Threads may use Work' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('Threads in every project may use it, and so may Watcher.')).toBeTruthy()
  await act(async () => { fireEvent.click(toggle) })
  expect(updates).toEqual([{ id: work.id, on: false }])
  expect(screen.getByRole('switch', { name: 'Threads may use Work' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByText('Off. No thread can see or use this account until you turn it back on. Its token stays saved.')).toBeTruthy()
  // With the account off there is nothing to keep it to, and its row says it is off.
  expect(screen.queryByRole('group', { name: 'Projects whose threads may use Work' })).toBeNull()
  expect(vercelRow().textContent).toContain('Work (off)')
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Threads may use Work' })) })
  expect(updates.at(-1)).toEqual({ id: work.id, on: true })
})

it('keeps an account to the projects pressed, and gives it back to every project when the last is let go', async () => {
  const { bridge, updates } = threadsBridge(work)
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('group', { name: 'Projects whose threads may use Work' })
  // A settled project is not offered while the account is not kept to it.
  expect(chips()).toEqual([{ name: 'Every project', pressed: true }, { name: 'Sotto', pressed: false }, { name: 'Lumen shop', pressed: false }])
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lumen shop' })) })
  expect(updates).toEqual([{ id: work.id, projects: ['p-site'] }])
  expect(chips()).toEqual([{ name: 'Every project', pressed: false }, { name: 'Sotto', pressed: false }, { name: 'Lumen shop', pressed: true }])
  expect(screen.getByText('Only threads in Lumen shop may use it. Watcher belongs to no project, so it cannot.')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sotto' })) })
  expect(updates.at(-1)).toEqual({ id: work.id, projects: ['p-site', 'p-sotto'] })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sotto' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lumen shop' })) })
  expect(updates.at(-1)).toEqual({ id: work.id, projects: null })
  expect(chips()[0]).toEqual({ name: 'Every project', pressed: true })
  // Every project, pressed while it already is, asks main for nothing.
  const before = updates.length
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Every project' })) })
  expect(updates).toHaveLength(before)
})

it('still shows a settled project an account is kept to, and a project that is gone, so either can be let go', async () => {
  const { bridge, updates } = threadsBridge({ ...work, projects: ['p-old', 'p-gone'] })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('group', { name: 'Projects whose threads may use Work' })
  expect(chips()).toEqual([{ name: 'Every project', pressed: false }, { name: 'Sotto', pressed: false }, { name: 'Lumen shop', pressed: false }, { name: 'Old site', pressed: true }, { name: 'A project that is gone', pressed: true }])
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'A project that is gone' })) })
  expect(updates).toEqual([{ id: work.id, projects: ['p-old'] }])
  expect(screen.queryByRole('button', { name: 'A project that is gone' })).toBeNull()
})

it('says so when a change to which threads may use an account could not be saved, and shows what is still kept', async () => {
  const bridge = vercelBridge([work], { projects: async () => [{ id: 'p-sotto', title: 'Sotto', settled: false }], updateAccount: async () => ({ ok: false, problem: 'store' }) })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await act(async () => { fireEvent.click(await screen.findByRole('switch', { name: 'Threads may use Work' })) })
  expect(screen.getByRole('alert').textContent).toBe('That could not be saved. What is shown is what is kept. Try again.')
  expect(screen.getByRole('switch', { name: 'Threads may use Work' }).getAttribute('aria-checked')).toBe('true')
})

it('works a press out from what was last asked for, so two quick presses never give the account to every project', async () => {
  // Main is slow: neither save has been answered when the second press lands.
  const answers: { request: PluginAccountUpdate; answer: ReturnType<typeof deferred<PluginAccountResult>> }[] = []
  const start = { ...work, projects: ['p-sotto'] }
  const bridge = vercelBridge([start], {
    projects: async () => [{ id: 'p-sotto', title: 'Sotto', settled: false }, { id: 'p-site', title: 'Lumen shop', settled: false }],
    updateAccount: request => { const answer = deferred<PluginAccountResult>(); answers.push({ request, answer }); return answer.promise },
  })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('group', { name: 'Projects whose threads may use Work' })
  // Lumen shop is added, then Sotto is let go: the user means Lumen shop alone.
  fireEvent.click(screen.getByRole('button', { name: 'Lumen shop' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sotto' }))
  expect(answers.map(entry => entry.request)).toEqual([{ id: work.id, projects: ['p-sotto', 'p-site'] }, { id: work.id, projects: ['p-site'] }])
  await act(async () => {
    answers[0]!.answer.resolve({ ok: true, accounts: [{ ...start, projects: ['p-sotto', 'p-site'] }] })
    answers[1]!.answer.resolve({ ok: true, accounts: [{ ...start, projects: ['p-site'] }] })
  })
  expect(chips()).toEqual([{ name: 'Every project', pressed: false }, { name: 'Sotto', pressed: false }, { name: 'Lumen shop', pressed: true }])
  // The switch turned twice in a row ends where it began, rather than sending the same answer twice.
  const toggle = screen.getByRole('switch', { name: 'Threads may use Work' })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(answers.slice(2).map(entry => entry.request)).toEqual([{ id: work.id, on: false }, { id: work.id, on: true }])
})

/** Two quick presses with main slow to answer: each save's answer is in the test's hands. */
async function twoPresses(start: PluginAccount) {
  const answers: { request: PluginAccountUpdate; answer: ReturnType<typeof deferred<PluginAccountResult>> }[] = []
  const bridge = vercelBridge([start], {
    projects: async () => [{ id: 'p-sotto', title: 'Sotto', settled: false }, { id: 'p-site', title: 'Lumen shop', settled: false }],
    updateAccount: request => { const answer = deferred<PluginAccountResult>(); answers.push({ request, answer }); return answer.promise },
  })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('group', { name: 'Projects whose threads may use Work' })
  fireEvent.click(screen.getByRole('button', { name: 'Sotto' }))
  fireEvent.click(screen.getByRole('button', { name: 'Lumen shop' }))
  expect(answers.map(entry => entry.request.projects)).toEqual([['p-sotto'], ['p-sotto', 'p-site']])
  return answers
}

it('says nothing failed when an earlier save failed and a later one, built on it, was kept', async () => {
  const answers = await twoPresses(work)
  await act(async () => {
    answers[0]!.answer.resolve({ ok: false, problem: 'store' })
    answers[1]!.answer.resolve({ ok: true, accounts: [{ ...work, projects: ['p-sotto', 'p-site'] }] })
  })
  // Main kept both projects, which is what the two presses asked for: the page shows that and no error.
  expect(chips()).toEqual([{ name: 'Every project', pressed: false }, { name: 'Sotto', pressed: true }, { name: 'Lumen shop', pressed: true }])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows what main last kept, and says so, when the later of two saves failed', async () => {
  const answers = await twoPresses(work)
  await act(async () => {
    answers[0]!.answer.resolve({ ok: true, accounts: [{ ...work, projects: ['p-sotto'] }] })
    answers[1]!.answer.resolve({ ok: false, problem: 'store' })
  })
  expect(chips()).toEqual([{ name: 'Every project', pressed: false }, { name: 'Sotto', pressed: true }, { name: 'Lumen shop', pressed: false }])
  expect(screen.getByRole('alert').textContent).toBe('That could not be saved. What is shown is what is kept. Try again.')
  // The next press starts from what is kept, not from what was asked for and lost.
  fireEvent.click(screen.getByRole('button', { name: 'Lumen shop' }))
  expect(answers.at(-1)!.request.projects).toEqual(['p-sotto', 'p-site'])
})

it('calls no project gone, and lets none go, while this computer’s projects are unread or could not be read', async () => {
  const kept = { ...work, projects: ['p-site'] }
  const updateAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [{ ...kept, projects: null }] }))
  // The read fails: before the fix the page showed "A project that is gone", and pressing it gave the account to every project.
  const failing = vercelBridge([kept], { projects: async () => { throw new Error('PLUGIN_PROJECTS_UNAVAILABLE') }, updateAccount })
  await act(async () => { render(<PluginsSettings bridge={failing} />) })
  fireEvent.click(vercelRow())
  expect(await screen.findByText('It is kept to chosen projects.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'A project that is gone' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Every project' })).toBeNull()
  expect(screen.queryByText('It is kept to a project that is gone, so no thread can use it. Press Every project, or choose one.')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe('Your projects could not be read, so the projects this account is kept to cannot be changed here. Nothing was changed. Reopen Settings and try again.')
  // The switch still works: turning an account off never widens it.
  expect(screen.getByRole('switch', { name: 'Threads may use Work' })).toBeTruthy()
  expect(updateAccount).not.toHaveBeenCalled()
  cleanup()
  // Still reading: the same, without the alert.
  const reading = vercelBridge([kept], { projects: () => new Promise(() => undefined), updateAccount })
  await act(async () => { render(<PluginsSettings bridge={reading} />) })
  fireEvent.click(vercelRow())
  expect(await screen.findByText('It is kept to chosen projects.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'A project that is gone' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

/** A bridge with one computer paired, forge, and the account's copy there in a state the test names. */
function copiesBridge(state: PluginCopiesView['copies'][number]['state'], options: { connected?: boolean; account?: PluginAccount; leaving?: PluginCopiesView['copies'][number]['leaving']; readable?: boolean; signIn?: Omit<PluginHostSignIn, 'computerId' | 'name'> | 'unread' | 'slow' } = {}) {
  const account = options.account ?? work
  let view: PluginCopiesView = { copyNew: true, readable: options.readable !== false, computers: [{ id: 'saved-forge', name: 'forge', connected: options.connected !== false }], copies: [{ accountId: account.id, computerId: 'saved-forge', state, leaving: options.leaving ?? 'no' }] }
  const sets: PluginCopySet[] = []
  const defaults: boolean[] = []
  let heard: (() => void) | undefined
  let elsewhereAsked = 0
  const signIn: { current: Omit<PluginHostSignIn, 'computerId' | 'name'> | 'unread' | 'slow' } = { current: options.signIn ?? { state: 'signed-in', login: 'host-user' } }
  const bridge = vercelBridge([account], {
    copies: async () => view,
    setCopy: async request => { sets.push(request); view = { ...view, copies: [{ accountId: account.id, computerId: 'saved-forge', state: request.on ? 'waiting' : 'off', leaving: request.on ? 'no' : 'now' }] }; return view },
    setCopyNew: async copyNew => { defaults.push(copyNew); view = { ...view, copyNew }; return view },
    onCopiesChanged: listener => { heard = listener; return () => { heard = undefined } },
    // forge's own gh, signed in as someone other than this computer's account unless a test says otherwise.
    gitHubSignInElsewhere: async () => {
      elsewhereAsked += 1
      if (signIn.current === 'unread') throw new Error('The hosts could not be asked.')
      // A read that is still on its way, as one waiting on a slow computer is.
      if (signIn.current === 'slow') return new Promise<PluginHostSignIn[]>(() => undefined)
      return [{ computerId: 'saved-forge', name: 'forge', ...signIn.current }]
    },
  })
  /** forge connects or leaves, and main says the copies changed. */
  const connect = (connected: boolean): void => { view = { ...view, computers: [{ id: 'saved-forge', name: 'forge', connected }] }; heard?.() }
  return { bridge, sets, defaults, signIn, elsewhereAsked: () => elsewhereAsked, connect, arrive: (next: PluginCopiesView['copies'][number]['state']) => { view = { ...view, copies: [{ accountId: account.id, computerId: 'saved-forge', state: next, leaving: 'no' }] }; heard?.() }, listening: () => heard !== undefined }
}
const copySwitch = (): HTMLElement => screen.getByRole('switch', { name: 'Keep a copy of Work on forge' })
const copyLine = (): string => copySwitch().querySelector('.tt-field__description')?.textContent ?? ''

it('says where an account’s secret is kept, and lets a copy on another computer be stopped and started', async () => {
  const { bridge, sets, arrive } = copiesBridge('kept')
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  const kept = await screen.findByRole('region', { name: 'Where its secret is kept' })
  expect(within(kept).getByText('This computer')).toBeTruthy()
  expect(within(kept).getByText('Always, in Sotto’s encrypted store.')).toBeTruthy()
  expect(copySwitch().getAttribute('aria-checked')).toBe('true')
  expect(copyLine()).toBe('A copy is kept on forge.')
  // Switched off: main is told for this account and this computer, and the line says what that means.
  await act(async () => { fireEvent.click(copySwitch()) })
  expect(sets).toEqual([{ accountId: work.id, computerId: 'saved-forge', on: false }])
  expect(copySwitch().getAttribute('aria-checked')).toBe('false')
  // forge has not said yet that it let the copy go, so the page does not say there is none.
  expect(copyLine()).toBe('No copy from now on. Sotto is taking the copy back from forge.')
  await act(async () => { arrive('off') })
  expect(copyLine()).toBe('No copy. forge’s threads cannot use this account.')
  await act(async () => { fireEvent.click(copySwitch()) })
  expect(sets.at(-1)).toEqual({ accountId: work.id, computerId: 'saved-forge', on: true })
  expect(copyLine()).toBe('Sending the copy to forge…')
})

it('says an account kept to chosen projects stays on this computer, with a switch that cannot be pressed', async () => {
  const { bridge, sets } = copiesBridge('here-only', { account: { ...work, projects: ['p-sotto'] } })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  expect(copySwitch().getAttribute('aria-checked')).toBe('false')
  expect((copySwitch() as HTMLButtonElement).disabled).toBe(true)
  expect(copyLine()).toBe('No copy. Work is kept to projects on this computer, so its secret stays here. Choose Every project to copy it.')
  await act(async () => { fireEvent.click(copySwitch()) })
  expect(sets).toEqual([])
  // It is not counted as a copy forge holds.
  expect(within(screen.getByRole('list', { name: 'Other computers' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['forgeConnected. Copies kept there: 0.'])
})

it('does not say a computer holds no copy until that computer has said so', async () => {
  const cases: [PluginCopiesView['copies'][number]['state'], PluginCopiesView['copies'][number]['leaving'], boolean, string][] = [
    ['off', 'away', false, 'No copy from now on. forge is not connected: if it holds a copy, it deletes it when it next connects.'],
    ['off', 'asking', true, 'No copy from now on. Sotto is making sure forge holds no copy.'],
    ['off', 'cannot', true, 'No copy from now on. forge’s Sotto cannot keep account copies now, so it cannot say whether it holds one from before. Update Sotto on forge, and a copy it holds is deleted.'],
    ['here-only', 'now', true, 'Work is kept to projects on this computer, so it is not copied. Sotto is taking the copy back from forge. Choose Every project to copy it.'],
    ['here-only', 'asking', true, 'Work is kept to projects on this computer, so it is not copied. Sotto is making sure forge holds no copy. Choose Every project to copy it.'],
    ['here-only', 'away', false, 'Work is kept to projects on this computer, so it is not copied. forge is not connected: if it holds a copy, it deletes it when it next connects. Choose Every project to copy it.'],
  ]
  for (const [state, leaving, connected, line] of cases) {
    const { bridge } = copiesBridge(state, { leaving, connected, account: state === 'here-only' ? { ...work, projects: ['p-sotto'] } : work })
    await act(async () => { render(<PluginsSettings bridge={bridge} />) })
    fireEvent.click(vercelRow())
    await screen.findByRole('region', { name: 'Where its secret is kept' })
    expect(copySwitch().getAttribute('aria-checked'), line).toBe('false')
    expect(copyLine()).toBe(line)
    cleanup()
  }
  // A copy forge is known to hold and is being told to let go is still counted there. One it has not been asked of
  // yet, or cannot speak of, is not: the count is of copies forge has said it holds.
  for (const [leaving, count] of [['now', 1], ['asking', 0], ['cannot', 0]] as const) {
    const { bridge } = copiesBridge('off', { leaving })
    await act(async () => { render(<PluginsSettings bridge={bridge} />) })
    expect((await screen.findByRole('list', { name: 'Other computers' })).textContent, leaving).toBe(`forgeConnected. Copies kept there: ${count}.`)
    cleanup()
  }
})

it('does not let a late answer to a choice undo a newer read of the copies', async () => {
  // The switch is pressed, and main says the copies changed before its answer to the press comes back.
  const { bridge, arrive } = copiesBridge('off')
  let answer!: (view: PluginCopiesView) => void
  const slow: PluginsBridge = { ...bridge, setCopy: () => new Promise<PluginCopiesView>(resolve => { answer = resolve }) }
  await act(async () => { render(<PluginsSettings bridge={slow} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  await act(async () => { fireEvent.click(copySwitch()) })
  await act(async () => { arrive('kept') })
  expect(copyLine()).toBe('A copy is kept on forge.')
  // The press is answered with the copies as they stood when it was made: older than what the page shows.
  await act(async () => { answer({ copyNew: true, readable: true, computers: [{ id: 'saved-forge', name: 'forge', connected: true }], copies: [{ accountId: work.id, computerId: 'saved-forge', state: 'waiting', leaving: 'no' }] }) })
  expect(copyLine()).toBe('A copy is kept on forge.')
})

it('says when the record of choices cannot be read, and lets none be changed', async () => {
  const { bridge, sets, defaults } = copiesBridge('no-record', { readable: false })
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  expect((await screen.findByRole('alert')).textContent).toBe('Sotto cannot read its record of which computers keep a copy, so it sends no copy and no choice can be changed. It still takes back the copy of an account you remove or keep to chosen projects. If a newer Sotto wrote the record, update Sotto on this computer.')
  const copyNew = screen.getByRole('switch', { name: 'Copy new accounts to every computer I pair' }) as HTMLButtonElement
  expect(copyNew.disabled).toBe(true)
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  expect((copySwitch() as HTMLButtonElement).disabled).toBe(true)
  expect(copySwitch().getAttribute('aria-checked')).toBe('false')
  expect(copyLine()).toBe('Sotto cannot read its record of which computers keep a copy, so it is not sending one to forge.')
  await act(async () => { fireEvent.click(copySwitch()); fireEvent.click(copyNew) })
  expect([sets, defaults]).toEqual([[], []])
  cleanup()
  // A copy the computer has said it holds is still shown as kept, with a switch that cannot be pressed.
  const held = copiesBridge('kept', { readable: false })
  await act(async () => { render(<PluginsSettings bridge={held.bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  expect(copyLine()).toBe('A copy is kept on forge.')
  expect((copySwitch() as HTMLButtonElement).disabled).toBe(true)
})

it('shows a copy arriving without being asked, and stops listening when the page goes', async () => {
  const { bridge, arrive, listening } = copiesBridge('waiting', { connected: false })
  let page!: ReturnType<typeof render>
  await act(async () => { page = render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  expect(copyLine()).toBe('forge is not connected. Sotto sends the copy, or checks the one there, when it is.')
  await act(async () => { arrive('kept') })
  expect(copyLine()).toBe('A copy is kept on forge.')
  expect(listening()).toBe(true)
  page.unmount()
  expect(listening()).toBe(false)
})

it('says in plain words why a computer holds no copy, and what to do where there is something to do', async () => {
  const lines: Record<string, string> = {
    'too-old': 'forge’s Sotto cannot keep account copies. Update Sotto on forge, and the copy is sent.',
    'no-key': 'forge was started without a key file, so it cannot keep a token. Nothing was kept there. On forge, set SOTTO_HOST_KEY_FILE to a file holding a secret of your own, start its host again, and the copy is sent.',
    full: 'forge already holds as many accounts as a plugin takes. Nothing was kept there.',
    'name-taken': 'Another of your computers already sent forge an account called Work. Rename one of the two. Nothing was kept there.',
    held: 'Another of your computers already sent forge this account. Nothing was changed there.',
    locked: 'This computer’s credential store is locked, so the token could not be read to send. Unlock it, and Sotto tries again.',
    failed: 'The copy could not be sent to forge. Sotto tries again.',
  }
  for (const [state, line] of Object.entries(lines)) {
    const { bridge } = copiesBridge(state as PluginCopiesView['copies'][number]['state'])
    await act(async () => { render(<PluginsSettings bridge={bridge} />) })
    fireEvent.click(vercelRow())
    await screen.findByRole('region', { name: 'Where its secret is kept' })
    expect(copyLine(), state).toBe(line)
    cleanup()
  }
})

it('says whose threads Recent use lists, and whose gh a thread on another computer uses, once another computer is paired', async () => {
  const records = 'Sotto records what was done and by which thread, never what was read or sent.'
  const gh = 'GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.'
  // With no other computer there is nothing to add.
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work])} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  fireEvent.click(vercelRow())
  expect(screen.getAllByText(records)).toHaveLength(2)
  expect(screen.getByText(gh).textContent).toBe(gh)
  cleanup()
  // With forge paired, its threads use plugins too: its own gh, and a record this page does not hold.
  const { bridge } = copiesBridge('kept')
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  fireEvent.click(vercelRow())
  await screen.findByRole('region', { name: 'Where its secret is kept' })
  const notes = [...document.querySelectorAll('.plugin-row__note')].map(note => note.textContent)
  expect(notes.filter(note => note === `${records} Only this computer’s threads are listed. Your other computers keep no record of use.`)).toHaveLength(2)
  expect(notes).toContain(`${gh} A thread on another of your computers uses the gh sign-in on that computer, which may be a different account.`)
})

const elsewhereLines = (): string[] => within(screen.getByRole('list', { name: 'GitHub’s sign-in on your other computers' })).getAllByRole('listitem').map(item => item.textContent ?? '')

it('shows who gh is signed in as on each other computer, since a thread there acts as that account', async () => {
  const f = copiesBridge('kept')
  await act(async () => { render(<PluginsSettings bridge={f.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  // This computer's account, and forge's, which is another.
  expect(screen.getByText('example-user')).toBeInTheDocument()
  await waitFor(() => expect(elsewhereLines()).toEqual(['forgeSigned in as host-user through gh on that computer.']))
  // Check again asks forge too.
  const before = f.elsewhereAsked()
  f.signIn.current = { state: 'signed-out' }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(f.elsewhereAsked()).toBe(before + 1)
  await waitFor(() => expect(elsewhereLines()).toEqual(['forgegh is not signed in there, so its threads cannot use GitHub. On forge, run gh auth login.']))
  // A copy changing asks no computer's gh again: each read starts gh there.
  const asked = f.elsewhereAsked()
  await act(async () => { f.arrive('kept') })
  expect(f.elsewhereAsked()).toBe(asked)
  // A computer leaving, or connecting, is asked without a press.
  f.signIn.current = { state: 'away' }
  await act(async () => { f.connect(false) })
  await waitFor(() => expect(elsewhereLines()).toEqual(['forgeNot connected, so its gh cannot be asked.']))
  expect(f.elsewhereAsked()).toBe(asked + 1)
  cleanup()
  // Each other thing a computer can say.
  const lines: [PluginHostSignIn['state'], string][] = [
    ['not-installed', 'forgegh isn’t installed there, so its threads cannot use GitHub.'],
    ['unknown', 'forgeSotto couldn’t ask its gh who is signed in.'],
    ['too-old', 'forgeIts Sotto is too old to say who gh is signed in as there. Its threads use that computer’s gh all the same. Update Sotto on forge to see the account.'],
    ['no-plugins', 'forgeIts Sotto runs no plugin tools, so its threads do not use GitHub through Sotto.'],
  ]
  for (const [state, line] of lines) {
    const { bridge } = copiesBridge('kept', { signIn: { state } })
    await act(async () => { render(<PluginsSettings bridge={bridge} />) })
    fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
    await waitFor(() => expect(elsewhereLines(), state).toEqual([line]))
    cleanup()
  }
})

it('shows a computer that has left as not connected at once, whatever read is still on its way', async () => {
  const f = copiesBridge('kept')
  await act(async () => { render(<PluginsSettings bridge={f.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  await waitFor(() => expect(elsewhereLines()).toEqual(['forgeSigned in as host-user through gh on that computer.']))
  // forge leaves, and the read that follows waits on another computer: forge is not left reading as signed in.
  f.signIn.current = 'slow'
  await act(async () => { f.connect(false) })
  expect(elsewhereLines()).toEqual(['forgeNot connected, so its gh cannot be asked.'])
  // It connects again, and is being asked until it has answered.
  await act(async () => { f.connect(true) })
  expect(elsewhereLines()).toEqual(['forgeSigned in as host-user through gh on that computer.'])
  cleanup()
  const away = copiesBridge('waiting', { connected: false, signIn: { state: 'away' } })
  await act(async () => { render(<PluginsSettings bridge={away.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  await waitFor(() => expect(elsewhereLines()).toEqual(['forgeNot connected, so its gh cannot be asked.']))
  away.signIn.current = 'slow'
  await act(async () => { away.connect(true) })
  expect(elsewhereLines()).toEqual(['forgeAsking its gh who is signed in…'])
})

it('adds nothing about another computer whose Sotto runs no plugin tools, and falls back to any paired computer while none has answered', async () => {
  const records = 'Sotto records what was done and by which thread, never what was read or sent.'
  const gh = 'GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.'
  // forge is a stable host: its threads use no plugin, so neither note is about it.
  const stable = copiesBridge('too-old', { signIn: { state: 'no-plugins' } })
  await act(async () => { render(<PluginsSettings bridge={stable.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  fireEvent.click(vercelRow())
  await waitFor(() => expect(elsewhereLines()).toHaveLength(1))
  const notes = (): (string | null)[] => [...document.querySelectorAll('.plugin-row__note')].map(note => note.textContent)
  expect(notes().filter(note => note === records)).toHaveLength(2)
  expect(notes()).toContain(gh)
  cleanup()
  // forge runs plugin tools on a Sotto from before it could say whose gh that is: its threads use its own gh, so
  // both notes are about it.
  const older = copiesBridge('kept', { signIn: { state: 'too-old' } })
  await act(async () => { render(<PluginsSettings bridge={older.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  fireEvent.click(vercelRow())
  await waitFor(() => expect(elsewhereLines()).toHaveLength(1))
  expect(notes()).toContain(`${gh} A thread on another of your computers uses the gh sign-in on that computer, which may be a different account.`)
  expect(notes().filter(note => note === `${records} Only this computer’s threads are listed. Your other computers keep no record of use.`)).toHaveLength(2)
  cleanup()
  // The computers could not be asked: with one paired, the notes stay, and no line claims anything of its gh.
  const unread = copiesBridge('kept', { signIn: 'unread' })
  await act(async () => { render(<PluginsSettings bridge={unread.bridge} />) })
  fireEvent.click(await screen.findByRole('button', { name: /^GitHub/u }))
  expect(screen.queryByRole('list', { name: 'GitHub’s sign-in on your other computers' })).toBeNull()
  expect(notes()).toContain(`${gh} A thread on another of your computers uses the gh sign-in on that computer, which may be a different account.`)
})

it('lists the other computers with what each holds, and keeps the default for new copies', async () => {
  const { bridge, defaults } = copiesBridge('kept')
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  const computers = await screen.findByRole('list', { name: 'Other computers' })
  expect(within(computers).getAllByRole('listitem').map(item => item.textContent)).toEqual(['forgeConnected. Copies kept there: 1.'])
  const copyNew = screen.getByRole('switch', { name: 'Copy new accounts to every computer I pair' })
  expect(copyNew.getAttribute('aria-checked')).toBe('true')
  await act(async () => { fireEvent.click(copyNew) })
  expect(defaults).toEqual([false])
  expect(screen.getByRole('switch', { name: 'Copy new accounts to every computer I pair' }).getAttribute('aria-checked')).toBe('false')
  cleanup()
  // A computer that is away says so, and with none paired the page says where to pair one and shows no switch per account.
  const away = copiesBridge('waiting', { connected: false })
  await act(async () => { render(<PluginsSettings bridge={away.bridge} />) })
  expect((await screen.findByRole('list', { name: 'Other computers' })).textContent).toBe('forgeNot connected. Copies wait until it is.')
  cleanup()
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work])} />) })
  expect(await screen.findByText('No other computer is paired. Pair one in Settings › Hosts & phones, and its threads can use these accounts too.')).toBeTruthy()
  fireEvent.click(vercelRow())
  expect(screen.queryByRole('region', { name: 'Where its secret is kept' })).toBeNull()
})

/** A made-up mail account and a made-up app password: nothing here is a real address or credential. */
const personal: PluginAccount = { id: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal', address: 'reader@example.com', savedAt: '2026-11-13T08:00:00.000Z', signedInAs: null, on: true, projects: null }
const APP_PASSWORD = 'madeupapppasswrd'
const gmailRow = (): HTMLElement => screen.getByRole('button', { name: /^Gmail/u })

it('lists Gmail under Mail, and adds an account by its name, its address and an app password that is not left in the page', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [personal] }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  expect(screen.getByText('Mail', { exact: true })).toBeInTheDocument()
  expect(gmailRow()).toHaveAccessibleName('Gmail Not added')
  expect(document.querySelector('[data-setting="plugin-gmail"]')).toContainElement(gmailRow())
  fireEvent.click(gmailRow())
  // The row says what a thread may do with mail, and that each thread asks first.
  expect(document.getElementById(gmailRow().getAttribute('aria-controls')!)).toHaveTextContent('Each thread asks you once, in the thread, before it reads an account’s mail, and what it reads goes to that thread’s provider. A thread cannot send, move or delete mail')
  fireEvent.click(screen.getByRole('button', { name: 'Add a Gmail account' }))
  const form = screen.getByRole('form', { name: 'Add a Gmail account' })
  expect(within(form).getByLabelText('Name')).toHaveFocus()
  const submit = within(form).getByRole('button', { name: 'Add account' })
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Personal ' } })
  const password = within(form).getByLabelText('App password')
  expect(password).toHaveAttribute('type', 'password')
  fireEvent.change(password, { target: { value: APP_PASSWORD } })
  // Without an address, or with something that is not one, there is nothing to sign in as.
  expect(submit).toHaveAttribute('aria-disabled', 'true')
  fireEvent.change(within(form).getByLabelText('Gmail address'), { target: { value: 'not an address' } })
  expect(submit).toHaveAttribute('aria-disabled', 'true')
  fireEvent.change(within(form).getByLabelText('Gmail address'), { target: { value: ' reader@example.com ' } })
  expect(submit).toHaveAttribute('aria-disabled', 'false')
  expect(form).toHaveTextContent('Sixteen characters, made at myaccount.google.com/apppasswords. It needs 2-Step Verification on the Google account.')
  await act(async () => { fireEvent.click(submit) })
  expect(addAccount).toHaveBeenCalledWith({ plugin: 'gmail', name: 'Personal', secret: APP_PASSWORD, address: 'reader@example.com' })
  expect(screen.queryByRole('form', { name: 'Add a Gmail account' })).toBeNull()
  expect(gmailRow()).toHaveAccessibleName('Gmail Personal')
  expect(screen.getByRole('region', { name: 'Gmail account Personal' })).toHaveTextContent(/reader@example\.com\. App password saved November 1[23]\./u)
  expect(document.body.innerHTML).not.toContain(APP_PASSWORD)
  // Vercel's row is not Gmail's: its account is listed under its own row alone.
  expect(vercelRow()).toHaveAccessibleName('Vercel Not added')
})

it('says in Gmail’s own words why an app password was not kept, and what replacing, removing and switching off do', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'refused' }))
  const replaceSecret = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'busy' }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([{ ...personal, on: false }], { addAccount, replaceSecret })} />) })
  expect(gmailRow()).toHaveAccessibleName('Gmail Personal (off)')
  fireEvent.click(gmailRow())
  const card = screen.getByRole('region', { name: 'Gmail account Personal' })
  expect(card).toHaveTextContent('Off. No thread can see or use this account until you turn it back on. Its app password stays saved.')

  fireEvent.click(within(card).getByRole('button', { name: 'Replace the app password for Personal' }))
  fireEvent.change(within(card).getByLabelText('New app password'), { target: { value: APP_PASSWORD } })
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Save app password' })) })
  expect(replaceSecret).toHaveBeenCalledWith({ id: personal.id, secret: APP_PASSWORD })
  expect(within(card).getByRole('alert')).toHaveTextContent('Gmail is turning sign-ins away for now, so the app password could not be checked. The app password already saved was kept. Wait a few minutes, then try again.')
  fireEvent.keyDown(within(card).getByLabelText('New app password'), { key: 'Escape' })

  fireEvent.click(within(card).getByRole('button', { name: 'Remove the Gmail account Personal' }))
  expect(within(card).getByRole('group', { name: 'Remove the Gmail account Personal' })).toHaveTextContent('Remove Personal? Its app password is deleted from this computer, and threads lose the account at once. Nothing changes at Gmail.')
  fireEvent.click(within(card).getByRole('button', { name: 'Keep it' }))

  fireEvent.click(screen.getByRole('button', { name: 'Add another Gmail account' }))
  const form = screen.getByRole('form', { name: 'Add a Gmail account' })
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Second' } })
  fireEvent.change(within(form).getByLabelText('Gmail address'), { target: { value: 'reader@example.org' } })
  fireEvent.change(within(form).getByLabelText('App password'), { target: { value: APP_PASSWORD } })
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Add account' })) })
  expect(within(form).getByRole('alert')).toHaveTextContent('Gmail did not accept this address and app password. Nothing was saved. Check the address, and make a new app password at myaccount.google.com/apppasswords.')
  // The address stays to be corrected; the refused app password is not kept in the page.
  expect(within(form).getByLabelText('Gmail address')).toHaveValue('reader@example.org')
  expect(within(form).getByLabelText('App password')).toHaveValue('')
  expect(document.body.innerHTML).not.toContain(APP_PASSWORD)
})

it('says of a mail account’s copy what another computer cannot keep, in mail’s words', async () => {
  const lines: Record<string, string> = {
    'too-old': 'forge’s Sotto cannot keep a mail account’s copy. Update Sotto on forge, and the copy is sent.',
    'no-key': 'forge was started without a key file, so it cannot keep an app password. Nothing was kept there. On forge, set SOTTO_HOST_KEY_FILE to a file holding a secret of your own, start its host again, and the copy is sent.',
    locked: 'This computer’s credential store is locked, so the app password could not be read to send. Unlock it, and Sotto tries again.',
    kept: 'A copy is kept on forge.',
  }
  for (const [state, line] of Object.entries(lines)) {
    const { bridge } = copiesBridge(state as PluginCopiesView['copies'][number]['state'], { account: personal })
    await act(async () => { render(<PluginsSettings bridge={bridge} />) })
    fireEvent.click(gmailRow())
    await screen.findByRole('region', { name: 'Where its secret is kept' })
    expect(screen.getByRole('switch', { name: 'Keep a copy of Personal on forge' }).querySelector('.tt-field__description')?.textContent, state).toBe(line)
    cleanup()
  }
})

it('says of a use of mail what was read, and of a first read you did not allow what was asked', async () => {
  const mail = { plugin: 'gmail' as const, accountId: personal.id, threadTitle: 'Tax papers' }
  const uses = [
    use(1, { ...mail, kind: 'mail-search' }),
    use(2, { ...mail, kind: 'mail-message' }),
    use(3, { ...mail, kind: 'mail-message', outcome: 'denied' }),
    use(4, { ...mail, kind: 'mail-search', outcome: 'lapsed' }),
    use(5, { ...mail, kind: 'mail-search', outcome: 'failed' }),
  ]
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([personal], { recentUse: async () => uses })} />) })
  fireEvent.click(gmailRow())
  const items = within(within(screen.getByRole('region', { name: 'Gmail account Personal' })).getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')
  expect(items.map(item => item.querySelector('span')!.textContent)).toEqual([
    'Searched mail in “Tax papers”',
    'Read a message in “Tax papers”',
    'Asked to read a message in “Tax papers” You said no.',
    'Asked to search mail in “Tax papers” Nobody answered in time.',
    'Searched mail in “Tax papers” It failed.',
  ])
})
