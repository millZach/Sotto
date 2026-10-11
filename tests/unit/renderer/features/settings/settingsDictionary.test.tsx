import { deferred, baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView, type SettingsViewProps } from '../../../../../src/renderer/src/features/settings/SettingsView'

describe('Personal dictionary draft acknowledgements', () => {
  it('keeps the paste status mounted and clears it when edits return below the limit', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) } })
    input.setSelectionRange(3990, 3990)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) + 'b'.repeat(10) } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('The pasted text was cut to fit the 4,000-character limit.')
    fireEvent.change(input, { target: { value: 'a'.repeat(3999) } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

  it('clears the cut-paste message after deleting text below the limit', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'a'.repeat(4000) } })
    input.setSelectionRange(4000, 4000)
    fireEvent.paste(input, { clipboardData: { getData: () => 'extra' } })
    expect(screen.getByText('The pasted text was cut to fit the 4,000-character limit.')).toBeVisible()
    fireEvent.change(input, { target: { value: 'a'.repeat(3999) } })
    expect(screen.queryByText('The pasted text was cut to fit the 4,000-character limit.')).not.toBeInTheDocument()
  })

  it('announces only pastes cut by the dictionary limit, accounting for the selection', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) } })
    input.setSelectionRange(3990, 3990)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    expect(screen.getByRole('status')).toHaveTextContent('The pasted text was cut to fit the 4,000-character limit.')
    input.setSelectionRange(0, 20)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    expect(screen.queryByText('The pasted text was cut to fit the 4,000-character limit.')).not.toBeInTheDocument()
  })

  it('limits the dictionary to 4000 characters and explains the limit when reached', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    expect(input).toHaveAttribute('maxlength', '4000')
    fireEvent.change(input, { target: { value: 'a'.repeat(4000) } })
    expect(input).toHaveAccessibleDescription(/4,000 characters maximum\./u)
  })

  it('flushes a changed dictionary draft on unmount without a blur', async () => {
    const update = vi.fn(async () => true)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')
    fireEvent.change(screen.getByRole('textbox', { name: 'Personal dictionary' }), { target: { value: 'Sotto\nZach' } })
    view.unmount()
    expect(update).toHaveBeenCalledExactlyOnceWith({ llmDictionary: 'Sotto\nZach' })
  })

  it('keeps an older failed save quiet when a newer dictionary save is pending after close', async () => {
    const older = deferred<boolean>()
    const newer = deferred<boolean>()
    const onNotice = vi.fn()
    const update = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update, onNotice })} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    fireEvent.change(input, { target: { value: 'Older' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'Newer' } })
    view.unmount()
    await act(async () => older.resolve(false))
    expect(onNotice).not.toHaveBeenCalled()
    await act(async () => newer.resolve(true))
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('does not duplicate an in-flight dictionary blur save on unmount', async () => {
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    fireEvent.change(input, { target: { value: 'Sotto' } })
    fireEvent.blur(input)
    view.unmount()
    expect(update).toHaveBeenCalledExactlyOnceWith({ llmDictionary: 'Sotto' })
    await act(async () => { pending.resolve(true) })
  })

  async function dictionary() {
    const answers: Array<ReturnType<typeof deferred<boolean>>> = []
    const update = vi.fn<SettingsViewProps['onUpdateSettings']>(() => { const answer = deferred<boolean>(); answers.push(answer); return answer.promise })
    const props = baseProps({ onUpdateSettings: update })
    const view = render(<SettingsView {...props} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    const edit = (value: string) => { input.focus(); fireEvent.change(input, { target: { value } }) }
    const publish = (value: string) => view.rerender(<SettingsView {...props} settings={{ ...props.settings, llmDictionary: value }} />)
    return { input, edit, publish, answers, update }
  }

  it.each(['before', 'after'] as const)('preserves newer typing when an older acknowledgement is published %s its save result', async order => {
    const f = await dictionary()
    f.edit('Sotto'); fireEvent.blur(f.input)
    f.edit('Sotto\nZach')
    if (order === 'before') f.publish('Sotto')
    await act(async () => f.answers[0]!.resolve(true))
    if (order === 'after') f.publish('Sotto')
    expect(f.input).toHaveValue('Sotto\nZach')
    expect(f.input).toHaveFocus()
    fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'Sotto\nZach' })
    f.publish('Sotto\nZach')
    await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('Sotto\nZach')
    expect(screen.getByText('Dictionary saved.')).toHaveAttribute('role', 'status')
  })

  it('retains the latest draft through repeated blur and refocus while earlier saves are queued', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B'); fireEvent.blur(f.input)
    f.edit('C')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('C')
    f.publish('B'); await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('C')
    fireEvent.blur(f.input)
    expect(f.update.mock.calls.map(([patch]) => patch)).toEqual([{ llmDictionary: 'A' }, { llmDictionary: 'B' }, { llmDictionary: 'C' }])
    f.publish('C'); await act(async () => f.answers[2]!.resolve(true))
    expect(f.input).toHaveValue('C')
  })

  it('saves a return to the previous value when an older different value is still queued', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit(''); fireEvent.blur(f.input)
    expect(f.update.mock.calls.map(([patch]) => patch)).toEqual([{ llmDictionary: 'A' }, { llmDictionary: '' }])
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('')
    f.publish(''); await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('')
  })

  it('accepts an external update while saving and ignores the older acknowledgement afterward', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.publish('External')
    expect(f.input).toHaveValue('External')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('External')
    fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'External' })
  })

  it('commits an explicit dictionary return to the value of an ignored older receipt', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.publish('External')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('External')
    f.edit('A'); fireEvent.blur(f.input)
    expect(f.update.mock.calls).toEqual([[{ llmDictionary: 'A' }], [{ llmDictionary: 'A' }]])
  })
  it('retains the draft when the update rejects and retries it on the next blur', async () => {
    const f = await dictionary()
    f.update.mockRejectedValueOnce(new Error('Synthetic save rejection'))
    f.edit('Sotto'); fireEvent.blur(f.input)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(f.input).toHaveValue('Sotto')
    f.input.focus(); fireEvent.blur(f.input)
    expect(f.update).toHaveBeenCalledTimes(2)
    f.publish('Sotto'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('Sotto')
  })

  it('keeps failed text available for another blur and never restores a superseded failed draft', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B'); fireEvent.blur(f.input)
    await act(async () => f.answers[0]!.resolve(false))
    expect(f.input).toHaveValue('B')
    await act(async () => f.answers[1]!.resolve(false))
    expect(f.input).toHaveValue('B')
    expect(screen.getByRole('alert')).toHaveTextContent('Your previous setting is still active.')
    f.input.focus(); fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'B' })
    f.publish('B'); await act(async () => f.answers[2]!.resolve(true))
    expect(f.input).toHaveValue('B')
  })

  it('accepts external settings updates and does not treat an unrelated setting publication as a dictionary acknowledgement', async () => {
    const f = await dictionary()
    f.publish('External')
    expect(f.input).toHaveValue('External')
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B')
    f.publish('External')
    expect(f.input).toHaveValue('B')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('B')
    f.publish('New external')
    expect(f.input).toHaveValue('New external')
  })

  it('saves exact multiline text on keyboard blur and skips an unchanged field', async () => {
    const f = await dictionary()
    const user = userEvent.setup()
    await user.click(f.input)
    await user.type(f.input, '  Sotto{Enter}Zach  ')
    await user.tab()
    expect(f.update).toHaveBeenCalledOnce()
    expect(f.update).toHaveBeenCalledWith({ llmDictionary: '  Sotto\nZach  ' })
    f.publish('  Sotto\nZach  '); await act(async () => f.answers[0]!.resolve(true))
    await user.click(f.input); await user.tab()
    expect(f.update).toHaveBeenCalledOnce()
    expect(f.input).toHaveValue('  Sotto\nZach  ')
  })
})

describe('Settings draft editing work', () => {
  it.each([
    { category: 'Cleanup', label: 'Personal dictionary', field: 'llmDictionary', text: 'Sotto', saved: 'Sotto', blurCommits: 0 },
    { category: 'Output', label: 'Paste delay', field: 'pasteDelayMs', text: '300', saved: 300, blurCommits: 1 },
  ])('does no extra render or request while editing $label', async ({ category, label, field, text, saved, blurCommits }) => {
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    let commits = 0
    const count = () => { commits += 1 }
    const view = render(<React.Profiler id="settings-drafts" onRender={count}><SettingsView {...props} /></React.Profiler>)
    await selectCategory(category)
    await act(async () => undefined)
    const input = screen.getByRole('textbox', { name: label })
    const before = commits
    for (let end = 1; end <= text.length; end += 1) fireEvent.change(input, { target: { value: text.slice(0, end) } })
    expect(commits - before).toBe(text.length)
    expect(update).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(update).toHaveBeenCalledExactlyOnceWith({ [field]: saved })
    expect(commits - before).toBe(text.length + blurCommits)
    await act(async () => { pending.resolve(true) })
    expect(commits - before).toBe(text.length + blurCommits + 1)
    const afterSave = commits
    view.rerender(<React.Profiler id="settings-drafts" onRender={count}><SettingsView {...props} settings={{ ...props.settings, [field]: saved }} /></React.Profiler>)
    expect(commits - afterSave).toBe(1)
    expect(input).toHaveValue(text)
    expect(update).toHaveBeenCalledTimes(1)
  })
})
