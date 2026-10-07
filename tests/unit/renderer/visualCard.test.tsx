/**
 * A visual an agent drew, in the transcript (ADR-0055): the card's header, drawing and Read all explanation, its
 * fallback when the diagram cannot be drawn, its keyboard path, and its place in a turn: out of the fold, never the
 * final reply, with the work that started after it drawn under it.
 */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'
import { visualFallbackText, type AgentVisual } from '../../../src/shared/visuals'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { VisualCard, isDrawableVisual } from '../../../src/renderer/src/agents/VisualCard'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import type { DiagramRenderResult } from '../../../src/renderer/src/agents/diagrams/diagramRenderer'

const renderer = vi.hoisted(() => ({ renderDiagram: vi.fn<(code: string) => Promise<DiagramRenderResult>>() }))
vi.mock('../../../src/renderer/src/agents/diagrams/diagramRenderer', () => renderer)

const DRAWING: DiagramRenderResult = { ok: true, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', width: 400, height: 200, title: null, description: null }
let sources = 0
/** A source no earlier test drew, so the module's drawing cache never answers for it. */
const freshSource = (): string => `flowchart LR\n  A${++sources}[Draft] --> B[Sent]`
const visual = (overrides: Partial<AgentVisual> = {}): AgentVisual => ({ id: 'v1', title: 'How a send moves', kind: 'diagram', source: freshSource(),
  intro: 'Sotto shows your message first.', steps: [{ text: 'You send.', highlight: ['A1'] }, { text: 'Codex runs it.' }], ...overrides })
const visualMessage = (value: AgentVisual, createdAt = '2026-10-06T10:00:30.000Z'): AgentMessage =>
  ({ id: `visual:${value.id}`, role: 'assistant', text: visualFallbackText(value), createdAt, visual: value })

beforeEach(() => { renderer.renderDiagram.mockReset(); renderer.renderDiagram.mockResolvedValue(DRAWING) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as { sotto?: unknown }).sotto })

describe('the visual card', () => {
  it('draws the header, the diagram and the intro with numbered steps', async () => {
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a send moves' })
    expect(within(card).getByRole('heading', { name: 'How a send moves' })).toBeInTheDocument()
    expect(within(card).getByText('Flowchart')).toBeInTheDocument()
    expect(await within(card).findByRole('img', { name: 'Flowchart: How a send moves' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Show source' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(card).getByRole('button', { name: 'Copy source' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Expand How a send moves' })).toHaveAttribute('aria-haspopup', 'dialog')
    expect(within(card).getByText('Sotto shows your message first.')).toBeInTheDocument()
    expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['You send.', 'Codex runs it.'])
    expect(card).toHaveAttribute('data-state', 'drawn')
  })

  it('shows the source with the reason when Mermaid cannot draw it, and keeps the steps readable', async () => {
    renderer.renderDiagram.mockResolvedValue({ ok: false, reason: 'The source has a syntax error on line 2.' })
    const value = visual()
    render(<VisualCard visual={value} />)
    expect(await screen.findByText('Couldn\'t draw this diagram. The source has a syntax error on line 2.')).toBeInTheDocument()
    expect(screen.getByLabelText('How a send moves source')).toHaveTextContent(`A${sources}[Draft] --> B[Sent]`)
    expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Expand/u })).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Visual: How a send moves' })).toHaveAttribute('data-state', 'failed')
  })

  it('shows source the checks refuse without asking Mermaid, with their reason', () => {
    render(<VisualCard visual={visual({ source: 'pie title Pets\n  "Dogs" : 386' })} />)
    expect(screen.getByText('Sotto doesn\'t draw “pie” diagrams. Sequence, flow, state, class and entity diagrams are drawn.')).toBeInTheDocument()
    expect(screen.getByText('Diagram')).toBeInTheDocument()
    expect(renderer.renderDiagram).not.toHaveBeenCalled()
  })

  it('leaves out the explanation when there is none', async () => {
    const { container } = render(<VisualCard visual={visual({ intro: undefined, steps: undefined })} />)
    await screen.findByRole('img')
    expect(container.querySelector('.visual-card__explain')).toBeNull()
  })

  it('reaches every control from the keyboard in reading order, toggles the source, copies it and expands', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const value = visual()
    render(<><button type="button">Before</button><VisualCard visual={value} /></>)
    await screen.findByRole('img')
    screen.getByRole('button', { name: 'Before' }).focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Show source' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Show source' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('How a send moves source')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Copy source' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Expand How a send moves' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('How a send moves source')).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Expand How a send moves' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('draws only visual messages of a kind this window knows', () => {
    expect(isDrawableVisual(visualMessage(visual()))).toBe(true)
    expect(isDrawableVisual({ ...visualMessage(visual()), visual: { ...visual(), kind: 'hologram' } })).toBe(false)
    expect(isDrawableVisual({ id: 'assistant-1', role: 'assistant', text: 'x', createdAt: '2026-10-06T10:00:00.000Z', visual: visual() })).toBe(false)
  })
})

describe('a visual in a turn', () => {
  const clock = (second: number): string => `2026-10-06T10:00:${String(second).padStart(2, '0')}.000Z`
  const say = (id: string, role: AgentMessage['role'], second: number, text = `${role} ${id}`): AgentMessage => ({ id, role, text, createdAt: clock(second) })
  const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
  const command = (id: string, sequence: number, startedAt: string, text: string): AgentActivity =>
    ({ id, turnId: 'u1', afterMessageId: 'a1', sequence, kind: 'command', status: 'completed', title: 'Bash', command: text, startedAt, completedAt: startedAt })

  it('stays out of the fold and is never the final reply', async () => {
    const drawnVisual = visual({ id: 'fold' })
    const messages = [say('u1', 'user', 0), say('a1', 'assistant', 10, 'Here is the flow.'), visualMessage(drawnVisual, clock(20)), say('a2', 'assistant', 40, 'That is all of it.')]
    const activities = [command('c1', 0, clock(12), 'npm run before'), command('c2', 1, clock(25), 'npm run after')]
    render(<MessageList messages={messages} provider="Claude" running={false} placement={placeActivities(messages, messages, activities)} context={context} />)
    const fold = screen.getByRole('region', { name: /Worked for/u })
    // The written reply on the way folds; the visual and the final reply stay in view.
    expect(within(fold).queryByRole('region', { name: 'Visual: How a send moves' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Visual: How a send moves' })).toBeInTheDocument()
    expect(document.body.textContent).toContain('That is all of it.')
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Worked for')).toBeLessThan(text.indexOf('How a send moves'))
    expect(text.indexOf('How a send moves')).toBeLessThan(text.indexOf('That is all of it.'))
  })

  it('keeps a visual drawn after the last reply after it', () => {
    const messages = [say('u1', 'user', 0), say('a1', 'assistant', 10, 'Drawing it now.'), say('a2', 'assistant', 15, 'Final words.'), visualMessage(visual({ id: 'late' }), clock(30))]
    const activities = [command('c1', 0, clock(12), 'npm run work')]
    render(<MessageList messages={messages} provider="Claude" running={false} placement={placeActivities(messages, messages, activities)} context={context} />)
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Final words.')).toBeLessThan(text.indexOf('How a send moves'))
  })

  it('places work that started after the visual under it, and work before it above', () => {
    const messages = [say('u1', 'user', 0), say('a1', 'assistant', 10), visualMessage(visual({ id: 'place' }), clock(20))]
    const untimed: AgentActivity = { id: 'untimed', turnId: 'u1', afterMessageId: 'a1', sequence: 2, kind: 'command', status: 'completed', title: 'Bash', command: 'npm run untimed' }
    const placement = placeActivities(messages, messages, [command('before', 0, clock(15), 'npm run before'), command('after', 1, clock(25), 'npm run after'), untimed])
    expect(placement.after.get('a1')?.flatMap(group => group.records.map(record => record.id))).toEqual(['before', 'untimed'])
    expect(placement.after.get('visual:place')?.flatMap(group => group.records.map(record => record.id))).toEqual(['after'])
  })

  it('folds a visual: message whose visual it could not read, as the words it is', async () => {
    const { visual: _dropped, ...words } = visualMessage(visual({ id: 'unread' }), clock(20))
    void _dropped
    const messages = [say('u1', 'user', 0), say('a1', 'assistant', 10, 'Here is the flow.'), words, say('a2', 'assistant', 40, 'That is all of it.')]
    const activities = [command('c1', 0, clock(12), 'npm run before')]
    render(<MessageList messages={messages} provider="Claude" running={false} placement={placeActivities(messages, messages, activities)} context={context} />)
    expect(document.body.textContent).not.toContain('The visual is in Sotto on your computer.')
    await userEvent.click(screen.getByRole('button', { name: /Worked for/u }))
    expect(within(screen.getByRole('region', { name: /Worked for/u })).getByText('The visual is in Sotto on your computer.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^Visual:/u })).toBeNull()
  })

  it('is drawn as its text when this window does not know its kind', () => {
    const unknown = { ...visualMessage(visual({ id: 'unknown' })), visual: { ...visual({ id: 'unknown' }), kind: 'hologram' } }
    const messages = [say('u1', 'user', 0), unknown]
    render(<MessageList messages={messages} provider="Claude" running={false} placement={placeActivities(messages, messages, [])} context={context} />)
    expect(screen.queryByRole('region', { name: /^Visual:/u })).toBeNull()
    expect(document.body.textContent).toContain('The visual is in Sotto on your computer.')
  })
})
