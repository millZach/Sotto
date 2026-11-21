import { createContext, useContext } from 'react'
import type { Editor } from '@tiptap/core'

/**
 * A reply editor the pane grid keeps across a switch to another thread (#2746). A pane is keyed by its thread, so picking
 * another thread in the sidebar takes the pane down and puts a new one up, and with it the composer's editor: on November
 * 20, 2026 building and taking down that editor cost the owner's window about 48 ms a switch. The grid keeps one editor per
 * slot instead. The composer of whichever thread holds the slot shows that editor in its own place, where its view's
 * events reach the pane and the composer as they always did, and a thread that takes over a slot gives the editor its own
 * draft and a fresh undo history (`PromptEditor`'s `owner`), so nothing of one thread's editing reaches another's.
 */
export interface PaneEditorSlot {
  /** Names the slot, so a thread can tell its own from another's. */
  readonly key: number
  /** The kept editor, made by the first composer to show one in this slot and taken down when the slot goes. */
  editor: Editor | null
  /** What the editor's callbacks read: the composer showing it now writes its own here. */
  readonly latest: { current: unknown }
}

let slots = 0
export function createPaneEditorSlot(): PaneEditorSlot {
  return { key: ++slots, editor: null, latest: { current: null } }
}

/**
 * The grid's slots for the threads now in panes: a thread that kept its pane keeps its slot, a thread new to the grid takes
 * the slot of one that left it, in the order they had them, and only past those is a slot made. A slot no thread took is
 * not in the answer; `releasePaneEditorSlots` takes its editor down.
 */
export function assignPaneEditorSlots(previous: ReadonlyMap<string, PaneEditorSlot>, threadIds: readonly string[]): Map<string, PaneEditorSlot> {
  const listed = new Set(threadIds)
  const freed = [...previous].filter(([threadId]) => !listed.has(threadId)).map(([, slot]) => slot)
  const next = new Map<string, PaneEditorSlot>()
  for (const threadId of threadIds) next.set(threadId, previous.get(threadId) ?? freed.shift() ?? createPaneEditorSlot())
  return next
}

/** Takes down the editors of slots in `previous` that `next` no longer holds, once the pane showing one has let it go. */
export function releasePaneEditorSlots(previous: ReadonlyMap<string, PaneEditorSlot>, next: ReadonlyMap<string, PaneEditorSlot>): void {
  const kept = new Set(next.values())
  for (const slot of new Set(previous.values())) {
    if (kept.has(slot) || slot.editor === null) continue
    const editor = slot.editor
    slot.editor = null
    // After the commit that let its pane go, as TipTap takes down an editor its component left.
    setTimeout(() => { if (!editor.isDestroyed) editor.destroy() }, 0)
  }
}

const PaneEditorContext = createContext<PaneEditorSlot | null>(null)
/** Hands a pane's composer the slot its thread holds. */
export const PaneEditorProvider = PaneEditorContext.Provider
/** The slot of the pane this editor is in, or null outside the pane grid. */
export function usePaneEditorSlot(): PaneEditorSlot | null { return useContext(PaneEditorContext) }
