import React, { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PromptEditor } from './PromptEditor'

type PromptEditorProps = ComponentProps<typeof PromptEditor>

/**
 * A reply editor the pane grid keeps across a switch to another thread (#2746). A pane is keyed by its thread, so picking
 * another thread in the sidebar takes the pane down and puts a new one up, and with it the composer's editor: on November
 * 20, 2026 building and taking down that editor cost the owner's window about 48 ms a switch. The grid keeps one editor per
 * slot instead, drawn into a container that outlives the pane, and the composer of whichever thread holds the slot shows that
 * container in its own place. A thread that takes over a slot gives the editor its own draft and a fresh undo history
 * (`PromptEditor`'s `owner`), so nothing of one thread's editing reaches another's.
 */
export interface PaneEditorSlot {
  /** Names the slot's host among the grid's children. */
  readonly key: number
  /** What the editor is drawn into: moved into the place of the composer that shows it. */
  readonly container: HTMLDivElement
  /** What the editor is drawn with now, set by the composer that shows it. */
  props: PromptEditorProps | null
  /** Draws the editor again with `props`; set by the slot's host while it is mounted. */
  redraw: () => void
}

let slots = 0
export function createPaneEditorSlot(): PaneEditorSlot {
  const container = document.createElement('div')
  // The container stands in the composer's own place and lays out as if it were not there.
  container.style.display = 'contents'
  return { key: ++slots, container, props: null, redraw: () => undefined }
}

/**
 * The grid's slots for the threads now in panes: a thread that kept its pane keeps its slot, a thread new to the grid takes
 * the slot of one that left it, in the order they had them, and only past those is a slot made. A slot no thread took goes,
 * and its editor with it.
 */
export function assignPaneEditorSlots(previous: ReadonlyMap<string, PaneEditorSlot>, threadIds: readonly string[], create = createPaneEditorSlot): Map<string, PaneEditorSlot> {
  const listed = new Set(threadIds)
  const freed = [...previous].filter(([threadId]) => !listed.has(threadId)).map(([, slot]) => slot)
  const next = new Map<string, PaneEditorSlot>()
  for (const threadId of threadIds) next.set(threadId, previous.get(threadId) ?? freed.shift() ?? create())
  return next
}

const PaneEditorContext = createContext<PaneEditorSlot | null>(null)
/** Hands a pane's composer the slot its thread holds. */
export const PaneEditorProvider = PaneEditorContext.Provider

/** Draws a slot's editor into its container, outside any pane, so a pane coming and going leaves it as it is. */
export function PaneEditorHost({ slot }: { readonly slot: PaneEditorSlot }): ReactNode {
  const [, setDrawn] = useState(0)
  useLayoutEffect(() => {
    slot.redraw = () => setDrawn(drawn => drawn + 1)
    // A composer that set its props before this host was up is drawn now.
    if (slot.props !== null) setDrawn(drawn => drawn + 1)
    return () => { slot.redraw = () => undefined }
  }, [slot])
  return slot.props === null ? null : createPortal(<PromptEditor {...slot.props} />, slot.container)
}

/** A composer's reply editor: its slot's kept editor where the pane grid keeps one, otherwise one of its own. */
export function KeptPromptEditor(props: PromptEditorProps): ReactNode {
  const slot = useContext(PaneEditorContext)
  const place = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = place.current
    if (slot === null || element === null) return undefined
    element.append(slot.container)
    return () => { if (slot.container.parentElement === element) slot.container.remove() }
  }, [slot])
  useLayoutEffect(() => {
    if (slot === null) return
    slot.props = props
    slot.redraw()
  })
  return slot === null ? <PromptEditor {...props} /> : <div ref={place} className="pane-editor-place" />
}
