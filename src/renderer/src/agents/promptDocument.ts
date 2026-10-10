import type { JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { AgentSkillReference } from '../../../shared/agentSkills'
import { MENTION_CLOSERS } from '../../../shared/mentions'
import type { SkillSigil } from './composerSkills'

/** One paragraph with hard breaks: even a final newline has its own node. */
export function textToPromptDoc(text: string, skills: readonly AgentSkillReference[] = [], sigils: readonly SkillSigil[] = ['$']): JSONContent {
  const matches: { start: number; end: number; skill: AgentSkillReference; token: string }[] = []
  for (const skill of skills) for (const sigil of sigils) {
    const token = `${sigil}${skill.name}`
    let start = text.indexOf(token)
    while (start !== -1) {
      const before = text[start - 1], after = text[start + token.length]
      if ((!before || /\s/u.test(before)) && (!after || MENTION_CLOSERS.test(after))) matches.push({ start, end: start + token.length, skill, token })
      start = text.indexOf(token, start + token.length)
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const content: JSONContent[] = []
  const plain = (value: string): void => {
    value.split('\n').forEach((line, index) => {
      if (index) content.push({ type: 'hardBreak' })
      if (line) content.push({ type: 'text', text: line })
    })
  }
  let offset = 0
  const placed: AgentSkillReference[] = []
  for (const match of matches) {
    if (match.start < offset || placed.some(skill => skill.name === match.skill.name && skill.path === match.skill.path)) continue
    plain(text.slice(offset, match.start))
    content.push({ type: 'skill', attrs: { ...match.skill, token: match.token } })
    placed.push(match.skill)
    offset = match.end
  }
  plain(text.slice(offset))
  return { type: 'doc', content: [{ type: 'paragraph', content }] }
}

/** Only atoms carry references while editing; repeated plain tokens carry none. */
export function promptDocSkills(doc: ProseMirrorNode): AgentSkillReference[] {
  const skills: AgentSkillReference[] = []
  doc.descendants(node => {
    if (node.type.name !== 'skill') return
    const skill = { name: node.attrs.name as string, path: node.attrs.path as string }
    if (!skills.some(item => item.name === skill.name && item.path === skill.path)) skills.push(skill)
  })
  return skills
}

export function promptDocText(doc: JSONContent): string {
  if (doc.type === 'text') return doc.text ?? ''
  if (doc.type === 'skill') return doc.attrs?.token as string ?? ''
  if (doc.type === 'hardBreak') return '\n'
  return (doc.content ?? []).map(promptDocText).join(doc.type === 'doc' ? '\n' : '')
}

/** Editable positions and serialised offsets differ only at atoms and paragraph boundaries. */
function textSpans(doc: ProseMirrorNode): { pos: number; size: number; text: string }[] {
  const spans: { pos: number; size: number; text: string }[] = []
  doc.descendants((node, pos) => {
    if (node.isText) spans.push({ pos, size: node.nodeSize, text: node.text! })
    else if (node.type.name === 'skill') spans.push({ pos, size: 1, text: node.attrs.token as string })
    else if (node.type.name === 'hardBreak') spans.push({ pos, size: 1, text: '\n' })
    else if (node.type.name === 'paragraph' && pos > 0) spans.push({ pos: pos - 1, size: 2, text: '\n' })
  })
  return spans
}

export function promptPositionToOffset(doc: ProseMirrorNode, position: number): number {
  let offset = 0
  for (const span of textSpans(doc)) {
    if (position <= span.pos) return offset
    if (position < span.pos + span.size) return offset + (span.size === span.text.length ? position - span.pos : 0)
    offset += span.text.length
  }
  return offset
}

export function promptOffsetToPosition(doc: ProseMirrorNode, offset: number): number {
  let consumed = 0
  for (const span of textSpans(doc)) {
    if (offset <= consumed + span.text.length) {
      const inside = Math.max(0, offset - consumed)
      return span.pos + (span.size === span.text.length ? inside : inside === 0 ? 0 : span.size)
    }
    consumed += span.text.length
  }
  return Math.max(1, doc.content.size - 1)
}
