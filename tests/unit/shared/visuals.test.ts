// @vitest-environment node
/**
 * A visual's checks and words (ADR-0055): the strict input the visualize tool takes, the diagram source checks main
 * shares with the renderer, the lenient shape a window reads, and the text a reader that cannot draw it is given.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentMessageSchema, summarizeThread, type AgentMessage } from '../../../src/shared/agents'
import { agentVisualSchema, checkVisualInput, isVisualMessageId, VISUAL_FALLBACK_NOTE, visualFallbackText, visualInputSchema, visualMessageId } from '../../../src/shared/visuals'

const FLOW = 'flowchart LR\n  A[Draft] --> B{Send}\n  B --> C[Running]'
const valid = { title: 'How a send moves', kind: 'diagram', source: FLOW, intro: 'Sotto shows the message first.', steps: [{ text: 'You send.', highlight: ['A'] }, { text: 'Codex runs it.', highlight: ['B->C'] }] }

describe('checking a visualize call', () => {
  it('takes a whole call and names the diagram kind for the reply', () => {
    const check = checkVisualInput(valid)
    expect(check).toEqual({ ok: true, input: valid, label: 'Flowchart' })
  })

  it('takes a call with only a title, a kind and a source', () => {
    expect(checkVisualInput({ title: 'T', kind: 'diagram', source: FLOW }).ok).toBe(true)
  })

  it.each([
    [{ ...valid, title: '' }, 'The title is empty.'],
    [{ ...valid, title: '   ' }, 'The title is empty.'],
    [{ ...valid, title: 'x'.repeat(121) }, 'The title is too long. It takes up to 120 characters.'],
    [{ ...valid, kind: 'interactive' }, 'The kind must be one of: diagram.'],
    [{ ...valid, source: 'x'.repeat(12_001) }, 'The source is too long. It takes up to 12,000 characters.'],
    [{ ...valid, intro: 'x'.repeat(2_001) }, 'The intro is too long. It takes up to 2,000 characters.'],
    [{ ...valid, steps: Array.from({ length: 13 }, () => ({ text: 'Step' })) }, 'There are too many steps. Send up to 12.'],
    [{ ...valid, steps: [{ text: '' }] }, 'Step 1 needs text of 1 to 1,000 characters.'],
    [{ ...valid, steps: [{ text: 'ok' }, { text: 'x'.repeat(1_001) }] }, 'Step 2 needs text of 1 to 1,000 characters.'],
    [{ ...valid, steps: [{ text: 'ok', highlight: Array.from({ length: 13 }, () => 'A') }] }, 'Step 1\'s highlight takes up to 12 names of 1 to 120 characters.'],
    [{ ...valid, steps: [{ text: 'ok', highlight: [''] }] }, 'Step 1\'s highlight takes up to 12 names of 1 to 120 characters.'],
    [{ ...valid, colour: 'red' }, 'The visual has fields it does not take: colour.'],
    [{ ...valid, steps: [{ text: 'ok', extra: true }] }, 'The visual has fields it does not take: extra.'],
  ])('refuses %j in plain words', (args, reason) => {
    expect(checkVisualInput(args)).toEqual({ ok: false, reason })
  })

  it('refuses source the diagram checks would not draw, with their reason', () => {
    const pie = checkVisualInput({ ...valid, source: 'pie title Pets\n  "Dogs" : 386' })
    expect(pie).toEqual({ ok: false, reason: 'The diagram cannot be drawn. Sotto doesn\'t draw “pie” diagrams. Sequence, flow, state, class and entity diagrams are drawn.' })
    const complex = checkVisualInput({ ...valid, source: `flowchart LR\n${Array.from({ length: 400 }, (_, index) => `  N${index} --> M${index}`).join('\n')}` })
    expect(complex.ok).toBe(false)
  })

  it('describes its input as a strict JSON schema the clients can read', () => {
    const schema = z.toJSONSchema(visualInputSchema, { io: 'input' }) as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> }
    expect(schema.required).toEqual(['title', 'kind', 'source'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(['title', 'kind', 'source', 'intro', 'steps'])
  })
})

describe('a visual as text', () => {
  it('gives the title, intro, numbered steps and where the drawing is', () => {
    expect(visualFallbackText(valid)).toBe(`**How a send moves**\n\nSotto shows the message first.\n\n1. You send.\n2. Codex runs it.\n\n${VISUAL_FALLBACK_NOTE}`)
  })

  it('keeps a step with line breaks one numbered item, and leaves out what is not there', () => {
    expect(visualFallbackText({ title: 'T', steps: [{ text: 'One\nmore' }] })).toBe(`**T**\n\n1. One\n   more\n\n${VISUAL_FALLBACK_NOTE}`)
    expect(visualFallbackText({ title: 'T' })).toBe(`**T**\n\n${VISUAL_FALLBACK_NOTE}`)
  })
})

describe('a visual on a message', () => {
  const message = { id: visualMessageId('v1'), role: 'assistant', text: 'words', createdAt: '2026-10-06T10:00:00.000Z' }

  it('keeps a visual of a kind this reader does not know, for the card to fall back to its text', () => {
    const parsed = agentMessageSchema.parse({ ...message, visual: { id: 'v1', title: 'T', kind: 'hologram', source: 's' } })
    expect(parsed.visual?.kind).toBe('hologram')
  })

  it('drops a visual it cannot read and keeps the message', () => {
    const parsed = agentMessageSchema.parse({ ...message, visual: { title: 42 } })
    expect(parsed.visual).toBeUndefined()
    expect(parsed.text).toBe('words')
    expect(agentVisualSchema.safeParse({ title: 42 }).success).toBe(false)
  })

  it('names visual messages by their prefix', () => {
    expect(isVisualMessageId('visual:abc')).toBe(true)
    expect(isVisualMessageId('assistant-1')).toBe(false)
  })

  it('leaves visuals out of the sidebar facts, so rows and search keep the agent\'s words', () => {
    const at = '2026-10-06T10:00:00.000Z'
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', text: 'Show me', createdAt: at },
      { id: 'a1', role: 'assistant', text: 'Here it is.', createdAt: at },
      { id: visualMessageId('v1'), role: 'assistant', text: visualFallbackText(valid), createdAt: '2026-10-06T10:00:05.000Z', visual: { id: 'v1', title: valid.title, kind: 'diagram', source: valid.source } },
    ]
    const summary = summarizeThread({ messages })
    expect(summary.lastAssistant?.text).toBe('Here it is.')
    expect(summary.messageCount).toBe(2)
    expect(summary.lastMessageAt).toBe(at)
  })
})
