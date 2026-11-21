import { NOW, renderThreads, stateFixture } from '../../../fixtures/renderer/threadsViewHarness'
import React from 'react'
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { assignPaneEditorSlots } from '../../../../src/renderer/src/agents/paneEditor'
import { SplitLayoutStore, openBeside } from '../../../../src/renderer/src/agents/splitLayout'
import type { PromptEditorElement } from '../../../../src/renderer/src/agents/promptSelection'
import type { AgentState } from '../../../../src/shared/agents'

describe('the pane grid’s kept reply editors (#2746)', () => {
  it('keeps a thread’s slot while its pane stays, hands a leaving thread’s to the one taking its place, and makes one only past those', () => {
    const first = assignPaneEditorSlots(new Map(), ['a', 'b'])
    const [a, b] = [first.get('a')!, first.get('b')!]
    expect(a).not.toBe(b)
    // A switch in the sidebar: the second pane's thread is replaced, and the new thread takes the slot it left.
    const switched = assignPaneEditorSlots(first, ['a', 'c'])
    expect(switched.get('a')).toBe(a)
    expect(switched.get('c')).toBe(b)
    // Moving panes keeps each thread's own slot; opening a pane beside makes one; closing one lets its slot go.
    expect(assignPaneEditorSlots(switched, ['c', 'a']).get('a')).toBe(a)
    const opened = assignPaneEditorSlots(switched, ['a', 'c', 'd'])
    expect([a, b]).not.toContain(opened.get('d'))
    expect([...assignPaneEditorSlots(opened, ['a']).values()]).toEqual([a])
  })

  it('draws the next thread’s draft in the same editor on a sidebar switch, and each thread’s undo and caret stay its own', async () => {
    const base = stateFixture()
    const [one, two] = base.host.threads.filter(thread => thread.kind === undefined)
    expect(one && two).toBeTruthy()
    const draft = (threadId: string, text: string) => ({ threadId, draftId: crypto.randomUUID(), text, attachments: [], requestId: null, updatedAt: '2026-11-21T00:00:00.000Z' })
    const state: AgentState = { ...base, activeThreadId: one!.id, threadDrafts: [draft(one!.id, 'First thread draft'), draft(two!.id, 'Second thread draft')] }
    const destroyed = vi.spyOn(Editor.prototype, 'destroy')
    const view = renderThreads(state)
    const field = (): PromptEditorElement => document.querySelector<PromptEditorElement>('.thread-pane:not([data-hidden]) .prompt-editor')!
    expect(field().dataset.promptText).toBe('First thread draft')
    const editor = field().editor
    // Typing in the first thread leaves an edit to undo there.
    act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' more') })
    expect(editor.can().undo()).toBe(true)
    act(() => { editor.commands.setTextSelection(3) })
    const caret = editor.state.selection.from
    state.activeThreadId = two!.id
    view.rerender(<ThreadsView now={NOW} />)
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    expect(field().editor).toBe(editor)
    expect(field().dataset.promptText).toBe('Second thread draft')
    // It stands in its own pane's composer, so the pane's focus and the composer's paste, drop and blur handlers hear it.
    expect(field().closest('.thread-pane')?.getAttribute('data-thread-id')).toBe(two!.id)
    expect(field().closest('.screenshot-input')).not.toBeNull()
    // The first thread's edit is not the second's to undo.
    expect(editor.can().undo()).toBe(false)
    expect(destroyed).not.toHaveBeenCalled()
    state.activeThreadId = one!.id
    view.rerender(<ThreadsView now={NOW} />)
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    expect(field().editor).toBe(editor)
    expect(field().dataset.promptText).toContain('First thread draft')
    // Back on the first thread, its own edit is there to undo again, and its caret where it was left.
    expect(editor.can().undo()).toBe(true)
    expect(editor.state.selection.from).toBe(caret)
    expect(destroyed).not.toHaveBeenCalled()
  })

  it('hands a pane its focus when its kept editor is focused, as the composer’s own editor did', () => {
    const state = stateFixture()
    const [one, two] = state.host.threads.filter(thread => thread.kind === undefined)
    const layoutStore = new SplitLayoutStore()
    layoutStore.set(openBeside(layoutStore.get(), one!.id, two!.id))
    const view = renderThreads({ ...state, activeThreadId: one!.id })
    act(() => { view.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />) })
    const second = document.querySelector<PromptEditorElement>(`.thread-pane[data-thread-id="${two!.id}"] .prompt-editor`)!
    view.command.mockClear()
    // The pane hears its editor's focus through React's tree, which an editor drawn from outside the pane would not reach.
    act(() => { fireEvent.focusIn(second) })
    expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread', threadId: two!.id }))
  })
})
