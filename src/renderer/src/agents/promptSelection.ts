import type { Editor } from '@tiptap/core'
import { promptOffsetToPosition, promptPositionToOffset } from './promptDocument'

export interface PromptSelection { readonly selectionStart: number; readonly selectionEnd: number }
export type PromptEditorElement = HTMLDivElement & { editor: Editor }

/** The focused thread's manual composer uses Tiptap; managed drafts have their own agent-composer surface. */
export function focusedComposerField(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.thread-pane[data-focused] .thread-prompt .prompt-editor')
}

export function promptSelection(editor: Editor): PromptSelection {
  return { selectionStart: promptPositionToOffset(editor.state.doc, editor.state.selection.from), selectionEnd: promptPositionToOffset(editor.state.doc, editor.state.selection.to) }
}
export function setPromptSelection(element: PromptEditorElement, start: number, end = start): void {
  element.editor.commands.setTextSelection({ from: promptOffsetToPosition(element.editor.state.doc, start), to: promptOffsetToPosition(element.editor.state.doc, end) })
}
