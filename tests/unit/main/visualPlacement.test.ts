// @vitest-environment node
/** Where a visual sits in a window (ADR-0055): after its anchor, else at the end of its turn, else nowhere. */
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { placeVisuals, visualMessage } from '../../../src/main/agents/visualPlacement'
import type { StoredVisual } from '../../../src/main/agents/threadStore'
import { VISUAL_FALLBACK_NOTE } from '../../../src/shared/visuals'

const at = '2026-10-06T10:00:00.000Z'
const message = (id: string, role: AgentMessage['role']): AgentMessage => ({ id, role, text: id, createdAt: at })
const stored = (id: string, anchorMessageId: string | null, anchorUserMessageId: string | null): StoredVisual => ({
  visual: { id, title: `Visual ${id}`, kind: 'diagram', source: 'flowchart LR\n  A --> B' }, createdAt: at, anchorMessageId, anchorUserMessageId,
})
const ids = (messages: readonly AgentMessage[]): string[] => messages.map(item => item.id)
const window = [message('u1', 'user'), message('a1', 'assistant'), message('a2', 'assistant'), message('u2', 'user'), message('a3', 'assistant')]

describe('placing visuals in a window', () => {
  it('makes a visual an assistant message with its own ID, the visual and its words', () => {
    const made = visualMessage(stored('v', 'a1', 'u1'))
    expect(made).toMatchObject({ id: 'visual:v', role: 'assistant', createdAt: at, visual: { id: 'v', kind: 'diagram' } })
    expect(made.text).toBe(`**Visual v**\n\n${VISUAL_FALLBACK_NOTE}`)
  })

  it('puts a visual right after the message it was anchored to, between the words before and after the call', () => {
    expect(ids(placeVisuals(window, [stored('v', 'a1', 'u1')], true))).toEqual(['u1', 'a1', 'visual:v', 'a2', 'u2', 'a3'])
  })

  it('keeps visuals on the same message in the order they were drawn', () => {
    expect(ids(placeVisuals(window, [stored('one', 'u2', 'u2'), stored('two', 'u2', 'u2')], true))).toEqual(['u1', 'a1', 'a2', 'u2', 'visual:one', 'visual:two', 'a3'])
  })

  it('puts a visual whose message is gone at the end of its turn', () => {
    expect(ids(placeVisuals(window, [stored('v', 'replaced', 'u1')], true))).toEqual(['u1', 'a1', 'a2', 'visual:v', 'u2', 'a3'])
    expect(ids(placeVisuals(window, [stored('v', 'replaced', 'u2')], true))).toEqual(['u1', 'a1', 'a2', 'u2', 'a3', 'visual:v'])
  })

  it('leaves out a visual whose turn is above the window or was taken back', () => {
    expect(ids(placeVisuals(window, [stored('v', 'older', 'u0')], false))).toEqual(ids(window))
  })

  it('leads a window that starts the thread with a visual drawn before any message, and only then', () => {
    expect(ids(placeVisuals(window, [stored('v', null, null)], true))[0]).toBe('visual:v')
    expect(ids(placeVisuals(window, [stored('v', null, null)], false))).toEqual(ids(window))
  })

  it('returns the window unchanged when the thread has no visuals', () => {
    expect(placeVisuals(window, [], true)).toEqual(window)
  })
})
