import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginsSettings } from '../../../../../src/renderer/src/features/settings/PluginsSettings'
import type { GitHubSignIn, PluginsBridge, ShownPluginUse } from '../../../../../src/shared/plugins'
import { deferred } from '../../../../fixtures/deferred'

afterEach(cleanup)

const noUses = async (): Promise<ShownPluginUse[]> => []
const answering = (...answers: readonly GitHubSignIn[]): { bridge: PluginsBridge; asked: () => number } => {
  let asked = 0
  return { bridge: { gitHubSignIn: async () => answers[Math.min(asked++, answers.length - 1)]!, recentUse: noUses }, asked: () => asked }
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
  const failing: PluginsBridge = { gitHubSignIn: async () => { throw new Error('spawn C:\\Users\\someone\\gh.exe EPERM') }, recentUse: noUses }
  await act(async () => { render(<PluginsSettings bridge={failing} />) })
  expect(row()).toHaveAccessibleName('GitHub Couldn’t check')
  fireEvent.click(row())
  expect(screen.getByText('Sotto couldn’t ask gh who is signed in. Nothing was changed. Press Check again.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('someone')
})

it('keeps focus on Check again while gh is asked, and takes no second press until it answers', async () => {
  const second = deferred<GitHubSignIn>()
  const gitHubSignIn = vi.fn<() => Promise<GitHubSignIn>>().mockResolvedValueOnce({ state: 'signed-out' }).mockReturnValueOnce(second.promise)
  await act(async () => { render(<PluginsSettings bridge={{ gitHubSignIn, recentUse: noUses }} />) })
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
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => uses }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  expect(screen.getByText('A thread’s agent uses a plugin through Sotto’s tools. So far they only read, and reading never asks you.')).toBeInTheDocument()
  fireEvent.click(row())
  const items = within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')
  expect(items.map(item => item.querySelector('span')!.textContent)).toEqual([
    'Read issues in “Fix the preview build”',
    'Read pull requests in “Review the release” It failed.',
    'Read from GitHub in a thread that is gone Sotto refused it.',
  ])
  expect(items[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T08:00:00.000Z')
  expect(screen.getByText('Sotto records what was done and by which thread, never what was read.')).toBeInTheDocument()
})

it('says when no thread has used a plugin yet, shows only the newest five, and reads the uses again on Check again', async () => {
  let asked = 0
  const many = Array.from({ length: 7 }, (_, index) => use(index + 1, { threadTitle: `Thread ${index + 1}` }))
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => asked++ === 0 ? [] : many }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.getByText('No thread has used GitHub yet.')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')).toHaveLength(5)
})

it('leaves Recent use out when the record could not be read, rather than saying nothing was used', async () => {
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => { throw new Error('EACCES') } }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.queryByRole('region', { name: 'Recent use' })).toBeNull()
  expect(screen.queryByText('No thread has used GitHub yet.')).toBeNull()
})
