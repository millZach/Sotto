import React, { createContext, useContext, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Node } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import { Slice } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin } from '@tiptap/pm/state'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react'
import type { AgentSkillCatalog, AgentSkillReference } from '../../../shared/agentSkills'
import { sameSkillReferences, skillScopeLabel, type SkillSigil } from './composerSkills'
import { MENTION_CLOSERS } from '../../../shared/mentions'
import { SkillPill } from './SkillPill'
import { isCompositionKey } from './composerKeys'
import { promptDocSkills, promptDocText, textToPromptDoc } from './promptDocument'
import { promptSelection, type PromptEditorElement, type PromptSelection } from './promptSelection'
export { promptSelection, setPromptSelection, type PromptEditorElement, type PromptSelection } from './promptSelection'

const Catalog = createContext<AgentSkillCatalog | undefined>(undefined)
function SkillView({ node }: NodeViewProps): ReactNode {
  const catalog = useContext(Catalog)
  const name = node.attrs.name as string, path = node.attrs.path as string
  const skill = catalog?.skills.find(item => item.name === name && item.path === path)
  return <NodeViewWrapper as="span" contentEditable={false} data-skill-token={node.attrs.token}>
    <SkillPill name={name} token={node.attrs.token as string} description={skill?.description} scope={skill ? skillScopeLabel(skill.scope) : undefined} />
  </NodeViewWrapper>
}
const Skill = Node.create({
  name: 'skill', group: 'inline', inline: true, atom: true, draggable: false, selectable: true,
  addAttributes: () => ({ name: { default: '' }, path: { default: '' }, token: { default: '' } }),
  // HTML never creates a selected skill; only the draft's references do.
  renderHTML: ({ node }) => ['span', { 'data-skill-token': node.attrs.token }, node.attrs.token as string],
  renderText: ({ node }) => node.attrs.token as string,
  addNodeView: () => ReactNodeViewRenderer(SkillView),
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const boundaries = new Set<number>()
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'skill') return
          const before = state.doc.resolve(pos).nodeBefore
          const after = state.doc.resolve(pos + node.nodeSize).nodeAfter
          // Hard breaks and paragraph edges are already boundaries. Keep valid sentence punctuation.
          if (before && before.type.name !== 'hardBreak' && (!before.isText || !/\s/u.test(before.text!.slice(-1)))) boundaries.add(pos)
          if (after && after.type.name !== 'hardBreak' && (!after.isText || !MENTION_CLOSERS.test(after.text![0]!))) boundaries.add(pos + node.nodeSize)
        })
        if (!boundaries.size) return null
        const transaction = state.tr
        // Work backwards so positions remain valid; ProseMirror maps the caret and undo with the edit.
        for (const pos of [...boundaries].sort((a, b) => b - a)) transaction.insertText(' ', pos)
        return transaction
      },
    })]
  },
  addKeyboardShortcuts() {
    const remove = (backward: boolean): boolean => {
      const { state, view } = this.editor
      if (!state.selection.empty) return false
      const { $from } = state.selection
      const node = backward ? $from.nodeBefore : $from.nodeAfter
      if (node?.type.name !== 'skill') return false
      view.dispatch(state.tr.delete(backward ? $from.pos - 1 : $from.pos, backward ? $from.pos : $from.pos + 1))
      return true
    }
    return { Backspace: () => remove(true), Delete: () => remove(false), Enter: () => this.editor.commands.setHardBreak(), 'Alt-Enter': () => this.editor.commands.setHardBreak() }
  },
})

/** A text draft's view. No formatting, HTML paste, persistence or provider protocol lives here. */
export function PromptEditor({ text, skills, sigils, catalog, fieldRef, caretAfterInsert, id, label, placeholder = '', editable = true, onChange, onSelection, onKeyDown, ...aria }: {
  readonly text: string
  readonly skills: readonly AgentSkillReference[]
  readonly sigils: readonly SkillSigil[]
  readonly catalog?: AgentSkillCatalog | undefined
  readonly fieldRef: RefObject<PromptEditorElement | null>
  /** A picker or option insertion is one undoable edit; store reconciliation is not. */
  readonly caretAfterInsert?: RefObject<number | null>
  readonly id?: string
  readonly label?: string
  readonly placeholder?: string
  readonly editable?: boolean
  readonly onChange: (text: string, pills: readonly AgentSkillReference[]) => void
  readonly onSelection?: (selection: PromptSelection) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly 'aria-describedby'?: string | undefined
  readonly 'aria-autocomplete'?: 'list' | undefined
  readonly 'aria-controls'?: string | undefined
  readonly 'aria-expanded'?: boolean | undefined
  readonly 'aria-activedescendant'?: string | undefined
}): ReactNode {
  const latest = useRef({ text, skills, onChange, onSelection })
  latest.current = { text, skills, onChange, onSelection }
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, HardBreak, History, Skill],
    content: textToPromptDoc(text, skills, sigils), editable,
    shouldRerenderOnTransaction: false,
    editorProps: {
      // A permission makes this div read-only. Keep its tab stop so Chromium
      // retains focus and Tab still leads to the request's decision controls.
      attributes: { tabindex: '0' },
      handleDOMEvents: {
        // Let the IME own confirmation without running the editor's Enter keymap.
        keydown: (_view, event) => isCompositionKey(event),
      },
      handlePaste: (view, event) => {
        if ([...(event.clipboardData?.items ?? [])].some(item => item.kind === 'file')) {
          // ScreenshotInput handles the bubbling event. Suppress ProseMirror's HTML/image paste.
          return true
        }
        const value = event.clipboardData?.getData('text/plain')
        if (value === undefined) return true
        event.preventDefault()
        const slice = view.state.schema.nodeFromJSON(textToPromptDoc(value)).firstChild!.content
        view.dispatch(view.state.tr.replaceSelection(new Slice(slice, 0, 0)).scrollIntoView())
        return true
      },
      handleDrop: (_view, event) => event.dataTransfer?.files.length ? true : false,
    },
    onUpdate: ({ editor: current }) => {
      const value = promptDocText(current.getJSON())
      const pills = promptDocSkills(current.state.doc)
      const element = current.view.dom as HTMLElement
      element.dataset.promptText = value
      element.dataset.empty = String(value === '')
      if (current.isEditable && (value !== latest.current.text || !sameSkillReferences(pills, latest.current.skills))) latest.current.onChange(value, pills)
      latest.current.onSelection?.(promptSelection(current))
    },
    onSelectionUpdate: ({ editor: current }) => latest.current.onSelection?.(promptSelection(current)),
    onFocus: ({ editor: current }) => latest.current.onSelection?.(promptSelection(current)),
  })
  useLayoutEffect(() => {
    if (!editor) return
    const element = editor.view.dom as PromptEditorElement
    fieldRef.current = element
    editor.setEditable(editable, false)
    const attributes: Record<string, string | undefined> = {
      id, role: 'textbox', 'aria-multiline': 'true', 'aria-label': label,
      'aria-disabled': editable ? undefined : 'true', 'data-placeholder': placeholder, spellcheck: 'true',
      ...Object.fromEntries(Object.entries(aria).map(([key, value]) => [key, value === undefined ? undefined : String(value)])),
    }
    element.classList.add('prompt-editor')
    for (const [key, value] of Object.entries(attributes)) { if (value === undefined) element.removeAttribute(key); else element.setAttribute(key, value) }
    // A local edit already owns its atoms. Rebuild only for external text or an explicit picker insertion.
    if (promptDocText(editor.getJSON()) !== text || caretAfterInsert?.current != null) {
      const next = editor.schema.nodeFromJSON(textToPromptDoc(text, skills, sigils))
      if (!editor.state.doc.eq(next)) {
        // Replace only the changed span so atom conversion does not erase the history around it.
        const start = editor.state.doc.content.findDiffStart(next.content)!
        const end = editor.state.doc.content.findDiffEnd(next.content)!
        let fromEnd = end.a, toEnd = end.b
        if (fromEnd < start) { toEnd += start - fromEnd; fromEnd = start }
        if (toEnd < start) { fromEnd += start - toEnd; toEnd = start }
        const userInsertion = caretAfterInsert?.current != null
        const transaction = editor.state.tr.replace(start, fromEnd, next.slice(start, toEnd)).setMeta('addToHistory', userInsertion)
        if (userInsertion) closeHistory(transaction)
        editor.view.dispatch(transaction.setMeta('preventUpdate', true))
        if (userInsertion) editor.view.dispatch(closeHistory(editor.state.tr).setMeta('preventUpdate', true))
      }
    }
    element.dataset.promptText = text
    element.dataset.empty = String(text === '')
  })
  useLayoutEffect(() => () => { fieldRef.current = null }, [fieldRef])
  return <Catalog.Provider value={catalog}><EditorContent editor={editor} onKeyDownCapture={onKeyDown} /></Catalog.Provider>
}
