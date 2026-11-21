import { NOW, renderThreads, stateFixture } from '../../../fixtures/renderer/threadsViewHarness'
import React from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { assignPaneEditorSlots, type PaneEditorSlot } from '../../../../src/renderer/src/agents/paneEditor'
import type { PromptEditorElement } from '../../../../src/renderer/src/agents/promptSelection'
import type { AgentState } from '../../../../src/shared/agents'

const slot = (key: number): PaneEditorSlot => ({ key, container: document.createElement('div'), props: null, redraw: () => undefined })

describe('the pane grid’s kept reply editors (#2746)', () => {
  it('keeps a thread’s slot while its pane stays, hands a leaving thread’s to the one taking its place, and makes one only past those', () => {
    let made = 10
    const create = (): PaneEditorSlot => slot(++made)
    const first = assignPaneEditorSlots(new Map(), ['a', 'b'], create)
    expect([...first.values()].map(item => item.key)).toEqual([11, 12])
    // A switch in the sidebar: the second pane's thread is replaced, and the new thread takes the slot it left.
    const switched = assignPaneEditorSlots(first, ['a', 'c'], create)
    expect(switched.get('a')).toBe(first.get('a'))
    expect(switched.get('c')).toBe(first.get('b'))
    // Moving panes keeps each thread's own slot; opening a pane beside makes one; closing one lets its slot go.
    expect(assignPaneEditorSlots(switched, ['c', 'a'], create).get('a')).toBe(first.get('a'))
    const opened = assignPaneEditorSlots(switched, ['a', 'c', 'd'], create)
    expect(opened.get('d')?.key).toBe(13)
    expect([...assignPaneEditorSlots(opened, ['a'], create).values()]).toEqual([first.get('a')])
  })

  it('draws the next thread’s draft in the same editor on a sidebar switch, with an undo history of its own', async () => {
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
    state.activeThreadId = two!.id
    view.rerender(<ThreadsView now={NOW} />)
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    expect(field().editor).toBe(editor)
    expect(field().dataset.promptText).toBe('Second thread draft')
    // The first thread's edit is not the second's to undo.
    expect(editor.can().undo()).toBe(false)
    expect(destroyed).not.toHaveBeenCalled()
    state.activeThreadId = one!.id
    view.rerender(<ThreadsView now={NOW} />)
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    expect(field().editor).toBe(editor)
    expect(field().dataset.promptText).toContain('First thread draft')
    expect(destroyed).not.toHaveBeenCalled()
  })
})
