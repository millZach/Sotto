import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import { Node } from '@tiptap/core'
import { promptDocText, promptOffsetToPosition, promptPositionToOffset, textToPromptDoc } from '../../../src/renderer/src/agents/promptDocument'

const skills = [{ name: 'review', path: '/review' }, { name: 'deploy', path: '/deploy' }]
const schema = getSchema([Document, Paragraph, Text, HardBreak, Node.create({ name: 'skill', group: 'inline', inline: true, atom: true, addAttributes: () => ({ name: {}, path: {}, token: {} }) })])

describe('a prompt document is an exact view of its text', () => {
  it.each(['', 'plain **text**', '\n', '\n\n', 'first\n\nlast\n', 'a\r\nb', '$review then /deploy\n\n$review!\n', '$unpicked /unpicked', 'prefix$review $review-long $review,'])('round trips %j', text => {
    const doc = textToPromptDoc(text, skills, ['$', '/'])
    expect(promptDocText(doc)).toBe(text)
    expect(promptDocText(schema.nodeFromJSON(doc).toJSON())).toBe(text)
  })
  it('only renders picked skills at the shared token boundaries', () => {
    const doc = textToPromptDoc('prefix$review $review-long $review, /deploy\n$unpicked', skills, ['$', '/'])
    expect(doc.content![0]!.content!.filter(node => node.type === 'skill').map(node => node.attrs)).toEqual([
      { ...skills[0], token: '$review' }, { ...skills[1], token: '/deploy' },
    ])
    expect(textToPromptDoc('/review', skills).content![0]!.content).toEqual([{ type: 'text', text: '/review' }])
  })
  it('counts an atom as the whole native token when mapping selections', () => {
    const doc = schema.nodeFromJSON(textToPromptDoc('a $review\n/deploy end\n', skills, ['$', '/']))
    for (const offset of [0, 1, 2, 9, 10, 17, 18, 21, 22]) {
      expect(promptPositionToOffset(doc, promptOffsetToPosition(doc, offset))).toBe(offset)
    }
    // A caret requested inside a pill goes to its far side, never into the atom.
    expect(promptPositionToOffset(doc, promptOffsetToPosition(doc, 3))).toBe(9)
  })
  it('converts only the first boundary-matched occurrence per reference in external text', () => {
    const text = 'prefix$review $review-long /review then $review and /review'
    const doc = textToPromptDoc(text, [skills[0]!, skills[0]!], ['$', '/'])
    expect(doc.content![0]!.content!.filter(node => node.type === 'skill').map(node => node.attrs)).toEqual([
      { ...skills[0], token: '/review' },
    ])
    expect(promptDocText(doc)).toBe(text)
  })
})
