import { act, fireEvent } from '@testing-library/react'
import type { AgentSkillReference } from '../../../../src/shared/agentSkills'
import { setPromptSelection as select, type PromptEditorElement } from '../../../../src/renderer/src/agents/promptSelection'
import { promptDocText, textToPromptDoc } from '../../../../src/renderer/src/agents/promptDocument'

/** Mixed handoff tests also drive the managed composer's unchanged textarea. */
export function setPromptText(element: HTMLElement, text: string): void {
  if (element instanceof HTMLTextAreaElement) { fireEvent.change(element, { target: { value: text } }); return }
  const field = element as PromptEditorElement
  if (!field.editor.isEditable) return
  const skills: AgentSkillReference[] = []
  field.editor.state.doc.descendants(node => { if (node.type.name === 'skill') skills.push({ name: node.attrs.name as string, path: node.attrs.path as string }) })
  act(() => {
    field.editor.commands.setContent(textToPromptDoc(text, skills, ['$', '/']))
    select(field, text.length)
  })
}
export function promptText(element: HTMLElement): string {
  return element instanceof HTMLTextAreaElement ? element.value : promptDocText((element as PromptEditorElement).editor.getJSON())
}
export function setPromptSelection(element: HTMLElement, start: number, end = start): void {
  act(() => {
    if (element instanceof HTMLTextAreaElement) element.setSelectionRange(start, end)
    else select(element as PromptEditorElement, start, end)
  })
}
