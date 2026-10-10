import { deferred } from '../../../../fixtures/deferred'
import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

describe('SettingsView', () => {
  it("offers the off switches for generated text and no writing model, since each thread's own model writes", async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')

    expect(screen.queryByRole('combobox', { name: 'Writing model' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Generated thread titles' })).toHaveAccessibleDescription(/thread's own model/u)
    await user.click(screen.getByRole('switch', { name: 'Generated thread titles' }))
    expect(update).toHaveBeenCalledWith({ threadTitles: false })
    await user.click(screen.getByRole('switch', { name: 'Generated commit messages' }))
    expect(update).toHaveBeenCalledWith({ commitMessages: false })
    await user.click(screen.getByRole('switch', { name: 'Generated pull request text' }))
    expect(update).toHaveBeenCalledWith({ pullRequestText: false })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ writingModel: expect.anything() }))
  })

  it('chooses the Commit and pull request style, with custom instructions saved as typing pauses', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    const style = screen.getByRole('combobox', { name: 'Commit and pull request style' })
    expect(style).toHaveValue('repository')
    expect(style).toHaveAccessibleDescription(/the way each repository's recent commits and AGENTS.md do/u)
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent('Let a thread name itself from its first exchange')
    expect(within(style).getAllByRole('option').map(option => option.textContent)).toEqual(['Repository conventions', 'Conventional Commits', 'Custom instructions'])
    expect(screen.queryByRole('textbox', { name: 'Custom instructions' })).toBeNull()
    await user.selectOptions(style, 'conventional')
    expect(update).toHaveBeenCalledWith({ gitWritingStyle: 'conventional' })
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'conventional' }} />)
    expect(style).toHaveAccessibleDescription(/starts with a type and scope/u)
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent('feat(threads): name a thread from its first exchange')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'custom' }} />)
    expect(style).toHaveAccessibleDescription(/they take precedence over the repository's style/u)
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    expect(instructions).toHaveAccessibleDescription('up to 2,000 characters')
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent(/Nothing written yet/u)
    await user.type(instructions, 'Subjects in the past tense.')
    // The example follows the text as typed, and says the thread's own model applies the instructions.
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent(/An example before your instructions/u)
    // No leaving the field needed: the pause saves it.
    await waitFor(() => expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Subjects in the past tense.' }))
  })

  it('says under the style when nothing will be drafted, because both Generated switches under Cleanup are off', async () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, commitMessages: false, pullRequestText: false } })} />)
    await selectCategory('Git')
    expect(screen.getByRole('combobox', { name: 'Commit and pull request style' })).toHaveAccessibleDescription(/Nothing is drafted while Generated commit messages and Generated pull request text are off under Cleanup/u)
  })

  it('tries a failed save of custom instructions again when the field is next left', async () => {
    const user = userEvent.setup()
    let accept = false
    const update = vi.fn(async (patch: object) => !('gitWritingInstructions' in patch) || accept)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    await user.type(instructions, 'Name the issue.')
    await user.tab()
    await waitFor(() => expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Name the issue.' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    // The failed text is waiting again: leaving the field once more saves it.
    accept = true
    await user.click(instructions)
    await user.tab()
    await waitFor(() => expect(update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object))).toHaveLength(2))
    expect(update).toHaveBeenLastCalledWith({ gitWritingInstructions: 'Name the issue.' })
    expect(instructions).toHaveValue('Name the issue.')
  })

  it('never brings back older custom instructions whose save failed after a newer save was sent', async () => {
    const user = userEvent.setup()
    const answers: Array<(saved: boolean) => void> = []
    const update = vi.fn((patch: object) => 'gitWritingInstructions' in patch ? (() => { const pending = deferred<boolean>(); answers.push(pending.resolve); return pending.promise })() : Promise.resolve(true))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    const saves = () => update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object)).map(([patch]) => (patch as { gitWritingInstructions: string }).gitWritingInstructions)
    // "abc" is sent and still in flight when "abcd" is sent.
    await user.type(instructions, 'abc')
    await user.tab()
    await user.click(instructions)
    await user.type(instructions, 'd')
    await user.tab()
    expect(saves()).toEqual(['abc', 'abcd'])
    // The older save fails after the newer one was sent, and the newer one succeeds.
    await act(async () => { answers[0]!(false) })
    await act(async () => { answers[1]!(true) })
    // Leaving the field again sends nothing: "abc" was superseded, not left waiting.
    await user.click(instructions)
    await user.tab()
    expect(saves()).toEqual(['abc', 'abcd'])
    expect(instructions).toHaveValue('abcd')
  })

  it('keeps custom instructions typed just before the style changes away from Custom instructions', async () => {
    const user = userEvent.setup()
    const update = vi.fn<Parameters<typeof SettingsView>[0]['onUpdateSettings']>(async () => true)
    const props = baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    // Typed and, before the pause, the style switched away: the field goes, and its text is saved as it goes.
    fireEvent.change(instructions, { target: { value: 'Mention the issue number.' } })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ gitWritingInstructions: expect.anything() }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Commit and pull request style' }), 'conventional')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'conventional' }} />)
    expect(screen.queryByRole('textbox', { name: 'Custom instructions' })).toBeNull()
    expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Mention the issue number.' })
    expect(update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object))).toHaveLength(1)
  })

  it('groups every Git setting under the moment it acts, in one Git section', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Git')
    const panel = screen.getByRole('tabpanel', { name: 'Git' })
    const groups = within(panel).getAllByRole('region')
    expect(groups.map(group => within(group).getByRole('heading', { level: 3 }).textContent)).toEqual(['When a thread commits', 'When a pull request is made or merged', 'When you read Changes', 'In the background'])
    // The controls of each group in the order the eye meets them.
    const names = (group: HTMLElement): string[] => [...group.querySelectorAll<HTMLElement>('select, [role="switch"], [role="radiogroup"]')]
      .map(control => control.getAttribute('aria-label') ?? (control as HTMLSelectElement).labels?.[0]?.textContent ?? '')
    expect(names(groups[0]!)).toEqual(['Commit and pull request style'])
    expect(names(groups[1]!)).toEqual(['Follow pull request templates', 'Default merge method', 'Auto-settle merged threads'])
    expect(names(groups[2]!)).toEqual(['Diff layout', 'Hide whitespace changes', 'Default diff file state', 'Proactive panels'])
    expect(names(groups[3]!)).toEqual(['Git fetch interval', 'Automatically pull'])
    // Moved, not copied: Application and Cleanup keep none of them.
    for (const section of ['Application', 'Cleanup']) {
      await selectCategory(section)
      const other = screen.getByRole('tabpanel', { name: section })
      for (const name of ['Git fetch interval', 'Default merge method', 'Commit and pull request style']) expect(within(other).queryByRole('combobox', { name })).toBeNull()
      for (const name of ['Automatically pull', 'Auto-settle merged threads', 'Proactive panels', 'Follow pull request templates', 'Hide whitespace changes']) expect(within(other).queryByRole('switch', { name })).toBeNull()
    }
  })

  it('saves each Git choice, with everything that acts on its own off to start and each description saying what the value does', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    for (const name of ['Automatically pull', 'Auto-settle merged threads', 'Proactive panels']) expect(screen.getByRole('switch', { name })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatically pull' })).toHaveAccessibleDescription(/leaves the pull to you/u)
    await user.click(screen.getByRole('switch', { name: 'Automatically pull' }))
    expect(update).toHaveBeenCalledWith({ gitAutoPull: true })
    const merge = screen.getByRole('combobox', { name: 'Default merge method' })
    expect(within(merge).getAllByRole('option').map(option => option.textContent)).toEqual(['Last selected', 'Merge', 'Squash and merge', 'Rebase and merge'])
    expect(merge).toHaveAccessibleDescription('The merge in the pull request checklist starts on the method you used last, Merge the first time.')
    await user.selectOptions(merge, 'squash')
    expect(update).toHaveBeenCalledWith({ defaultMergeMethod: 'squash' })
    await user.click(within(screen.getByRole('radiogroup', { name: 'Diff layout' })).getByRole('radio', { name: 'Split' }))
    expect(update).toHaveBeenCalledWith({ diffLayout: 'split' })
    await user.click(screen.getByRole('switch', { name: 'Hide whitespace changes' }))
    expect(update).toHaveBeenCalledWith({ diffHideWhitespace: false })
    await user.click(within(screen.getByRole('radiogroup', { name: 'Default diff file state' })).getByRole('radio', { name: 'Expanded' }))
    expect(update).toHaveBeenCalledWith({ diffFileState: 'expanded' })
    await user.click(screen.getByRole('switch', { name: 'Auto-settle merged threads' }))
    expect(update).toHaveBeenCalledWith({ autoSettleMergedThreads: true })
    await user.click(screen.getByRole('switch', { name: 'Proactive panels' }))
    expect(update).toHaveBeenCalledWith({ proactivePanels: true })
    await user.click(screen.getByRole('switch', { name: 'Follow pull request templates' }))
    expect(update).toHaveBeenCalledWith({ followPullRequestTemplates: false })
    const fetch = screen.getByRole('combobox', { name: 'Git fetch interval' })
    expect(fetch).toHaveAccessibleDescription(/Sotto asks origin every 30 seconds/u)
    await user.selectOptions(fetch, '0')
    expect(update).toHaveBeenCalledWith({ gitFetchIntervalSeconds: 0 })
    // Each description follows the value it describes.
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitAutoPull: true, defaultMergeMethod: 'squash', diffLayout: 'split', diffHideWhitespace: false, diffFileState: 'expanded', autoSettleMergedThreads: true, proactivePanels: true, followPullRequestTemplates: false, gitFetchIntervalSeconds: 60 }} />)
    expect(screen.getByRole('switch', { name: 'Automatically pull' })).toHaveAccessibleDescription(/Fast-forward only/u)
    expect(merge).toHaveAccessibleDescription('The merge in the pull request checklist starts on Squash and merge.')
    expect(screen.getByRole('radiogroup', { name: 'Diff layout' }).closest('.tt-field')).toHaveTextContent(/old on the left and new on the right/u)
    // The Changes group says once that these are only where Changes starts.
    expect(screen.getByRole('region', { name: 'When you read Changes' })).toHaveAccessibleDescription('These set where Changes starts. A choice made in Changes holds until one of these settings changes or Sotto restarts.')
    expect(screen.getByRole('switch', { name: 'Hide whitespace changes' })).toHaveAccessibleDescription('Changes starts showing every edit, spacing included.')
    expect(screen.getByRole('radiogroup', { name: 'Default diff file state' }).closest('.tt-field')).toHaveTextContent('Files in Changes start expanded.')
    expect(screen.getByRole('switch', { name: 'Auto-settle merged threads' })).toHaveAccessibleDescription(/asks GitHub through gh once an hour/u)
    expect(screen.getByRole('switch', { name: 'Proactive panels' })).toHaveAccessibleDescription(/at least 3 more changed files or 50 more changed lines\. It counts only while the Threads page is open\./u)
    expect(screen.getByRole('switch', { name: 'Follow pull request templates' })).toHaveAccessibleDescription(/it skips the template and uses Sotto's own sections/u)
    expect(fetch).toHaveAccessibleDescription(/Sotto asks origin every minute/u)
    rendered.rerender(<SettingsView {...props} />)
    expect(screen.getByRole('switch', { name: 'Follow pull request templates' })).toHaveAccessibleDescription("When a Git action drafts a pull request, the thread's own model follows the repository's pull request template, if Sotto finds one.")
  })
})
