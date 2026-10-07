/**
 * A visual's walkthrough (#793): the stepper on its own (count, dots, Back, Next, Start over, arrow keys, the words
 * read out), and in the card, where each step lights its part of a real Mermaid drawing, Read all lights it all, Expand
 * shows the step's lighting, and the step pictures cross-fade except under reduced motion.
 */
import React, { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentVisual } from '../../../src/shared/visuals'
import { VisualCard } from '../../../src/renderer/src/agents/VisualCard'
import { VisualStepper } from '../../../src/renderer/src/agents/VisualStepper'
import { CROSS_FADE_MS } from '../../../src/renderer/src/agents/diagrams/CrossFadeImage'
import type { DiagramRenderResult } from '../../../src/renderer/src/agents/diagrams/diagramRenderer'
import { LIT_CLASS } from '../../../src/renderer/src/agents/diagrams/diagramSteps'
import { svgDataUrl, toInertDiagramSvg } from '../../../src/renderer/src/agents/diagrams/diagramSvg'

const renderer = vi.hoisted(() => ({ renderDiagram: vi.fn<(code: string) => Promise<DiagramRenderResult>>() }))
vi.mock('../../../src/renderer/src/agents/diagrams/diagramRenderer', () => renderer)

const STEPS = [{ text: 'You write a draft.' }, { text: 'Sotto sends it.' }, { text: 'Codex answers.' }]

function Harness({ steps = STEPS, start = 0, onStep }: { steps?: typeof STEPS; start?: number; onStep?: (index: number) => void }): React.ReactNode {
  const [index, setIndex] = useState(start)
  return <><button type="button">Before</button><VisualStepper steps={steps} index={index} onStep={next => { onStep?.(next); setIndex(next) }} /></>
}

afterEach(() => { cleanup(); vi.useRealTimers(); delete document.documentElement.dataset.reducedMotion })

describe('the stepper', () => {
  it('shows the step, a dot for each step and Back and Next, with the words read out politely', () => {
    render(<Harness />)
    const stepper = screen.getByRole('group', { name: 'Walkthrough' })
    expect(stepper).toHaveTextContent('Step 1 of 3')
    const dots = within(within(stepper).getByRole('group', { name: 'Steps' })).getAllByRole('button')
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual(['Step 1', 'Step 2', 'Step 3'])
    expect(dots[0]).toHaveAttribute('aria-current', 'step')
    expect(dots[1]).not.toHaveAttribute('aria-current')
    expect(screen.getByText('You write a draft.')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument()
  })

  it('goes forward with Next, back with Back, and starts over from the last step', async () => {
    const onStep = vi.fn()
    render(<Harness onStep={onStep} />)
    const back = screen.getByRole('button', { name: 'Back' })
    await userEvent.click(back)
    expect(onStep).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Sotto sends it.')).toBeInTheDocument()
    expect(back).not.toHaveAttribute('aria-disabled')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('group', { name: 'Walkthrough' })).toHaveTextContent('Step 3 of 3')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByText('You write a draft.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(back)
    expect(onStep.mock.calls.map(([index]) => index)).toEqual([1, 2, 0, 1, 0])
  })

  it('goes to a step from its dot, marking the steps before it done', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Step 3' }))
    expect(screen.getByText('Codex answers.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Step 3' })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: 'Step 1' })).toHaveAttribute('data-state', 'done')
  })

  it('steps with Left and Right anywhere inside it, stopping at the ends, and leaves other keys alone', async () => {
    const user = userEvent.setup()
    const onStep = vi.fn()
    render(<Harness onStep={onStep} />)
    screen.getByRole('button', { name: 'Before' }).focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(onStep).not.toHaveBeenCalled()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(screen.getByText('Codex answers.')).toBeInTheDocument()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}{Control>}{ArrowLeft}{/Control}')
    expect(screen.getByText('Codex answers.')).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByText('Sotto sends it.')).toBeInTheDocument()
    expect(onStep.mock.calls.map(([index]) => index)).toEqual([1, 2, 1])
  })

  it('reaches Back, then Next, by Tab, leaving the dots to the pointer and the arrow keys', async () => {
    const user = userEvent.setup()
    render(<><Harness start={1} /><button type="button">After</button></>)
    screen.getByRole('button', { name: 'Before' }).focus()
    const order: string[] = []
    for (let press = 0; press < 3; press += 1) {
      await user.tab()
      order.push(document.activeElement!.textContent!)
    }
    expect(order).toEqual(['Back', 'Next', 'After'])
    // Still named for a reader, and a click still goes to the step.
    for (const dot of within(screen.getByRole('group', { name: 'Steps' })).getAllByRole('button')) expect(dot).toHaveAttribute('tabindex', '-1')
    await user.click(screen.getByRole('button', { name: 'Step 3' }))
    expect(screen.getByText('Codex answers.')).toBeInTheDocument()
  })

  it('draws nothing for a visual without steps', () => {
    const { container } = render(<VisualStepper steps={[]} index={0} onStep={() => undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})

// A flowchart Mermaid 11.17.2 drew, as the renderer returns it after the sanitizer.
const flow = toInertDiagramSvg(readFileSync(join(process.cwd(), 'tests/fixtures/mermaidSteps/flowchart.svg'), 'utf8'))!
const DRAWING: DiagramRenderResult = { ok: true, svg: flow.svg, dataUrl: svgDataUrl(flow.svg), width: flow.width, height: flow.height, title: null, description: null }
let sources = 0
const visual = (overrides: Partial<AgentVisual> = {}): AgentVisual => ({
  id: `walk-${sources + 1}`, title: 'How a draft is sent', kind: 'diagram', source: `flowchart LR\n  A${++sources}[Draft] --> B[Sent]`, intro: 'From draft to answer.',
  steps: [{ text: 'You write a draft.', highlight: ['A'] }, { text: 'It goes to the provider.', highlight: ['Provider'] }, { text: 'Codex answers.' }], ...overrides,
})
/** The parts a picture lights, by the ids Mermaid gave them; empty for the drawing as it is. */
const litIn = (image: HTMLElement): string[] => {
  const svg = new TextDecoder().decode(Uint8Array.from(atob(image.getAttribute('src')!.split(',')[1]!), char => char.charCodeAt(0)))
  return [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll(`.${LIT_CLASS}`)].map(element => element.getAttribute('id') ?? element.getAttribute('class')!.split(' ')[0]!)
}
const shown = (card: HTMLElement): HTMLElement => within(card).getByRole('img', { name: 'Flowchart: How a draft is sent' })

describe('a walkthrough in the card', () => {
  beforeEach(() => { renderer.renderDiagram.mockReset(); renderer.renderDiagram.mockResolvedValue(DRAWING) })

  it('lights each step\'s part of the drawing, and the whole drawing for a step that names nothing', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    expect(litIn(shown(card))).toEqual(['sotto-diagram-flowchart-flowchart-A-0'])
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }))
    expect(litIn(shown(card))).toEqual(expect.arrayContaining(['sotto-diagram-flowchart-Provider', 'sotto-diagram-flowchart-flowchart-D-7']))
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }))
    expect(shown(card)).toHaveAttribute('src', DRAWING.ok && DRAWING.dataUrl)
    // Every step's picture is the drawing's size.
    expect(shown(card)).toHaveAttribute('width', String(flow.width))
    expect(shown(card)).toHaveAttribute('height', String(flow.height))
  })

  it('swaps the walkthrough for the intro and numbered steps under Read all, with nothing dimmed, and back', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }))
    const readAll = within(card).getByRole('button', { name: 'Read all' })
    await userEvent.click(readAll)
    // The same button, now named for going back.
    expect(readAll).toHaveAccessibleName('Step through')
    expect(readAll).not.toHaveAttribute('aria-pressed')
    expect(within(card).queryByRole('group', { name: 'Walkthrough' })).toBeNull()
    expect(within(card).getByText('From draft to answer.')).toBeInTheDocument()
    expect(within(card).getAllByRole('listitem')).toHaveLength(3)
    expect(litIn(shown(card))).toEqual([])
    await userEvent.click(readAll)
    expect(readAll).toHaveAccessibleName('Read all')
    // Back where it was.
    expect(within(card).getByRole('group', { name: 'Walkthrough' })).toHaveTextContent('Step 2 of 3')
    expect(litIn(shown(card))).toContain('sotto-diagram-flowchart-Provider')
  })

  it('expands the step as it is lit', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    await userEvent.click(within(card).getByRole('button', { name: 'Expand How a draft is sent' }))
    const viewer = screen.getByRole('dialog')
    expect(litIn(within(viewer).getByRole('img'))).toEqual(['sotto-diagram-flowchart-flowchart-A-0'])
  })

  it('shows a single step as its words under its lit part, with no count, dots, Back or Next', async () => {
    render(<VisualCard visual={visual({ steps: [{ text: 'You write a draft.', highlight: ['A'] }] })} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    const walkthrough = within(card).getByRole('group', { name: 'Walkthrough' })
    expect(walkthrough).toHaveTextContent(/^You write a draft\.$/u)
    expect(within(walkthrough).queryAllByRole('button')).toEqual([])
    expect(litIn(shown(card))).toEqual(['sotto-diagram-flowchart-flowchart-A-0'])
  })

  it('shows no stepper and no Read all for a visual without steps, and its intro', async () => {
    render(<VisualCard visual={visual({ steps: undefined })} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    expect(within(card).queryByRole('group', { name: 'Walkthrough' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Read all' })).toBeNull()
    expect(within(card).getByText('From draft to answer.')).toBeInTheDocument()
    expect(litIn(shown(card))).toEqual([])
  })

  it('cross-fades from one step\'s picture to the next, with only the new one named', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }))
    const frames = card.querySelector('.visual-card__frames')!
    const layers = [...frames.querySelectorAll('img')]
    expect(layers.map(layer => layer.dataset.layer)).toEqual(['leaving', 'arriving'])
    expect(layers[0]).toHaveAttribute('aria-hidden', 'true')
    expect(layers[0]).toHaveAttribute('alt', '')
    expect(within(card).getAllByRole('img')).toHaveLength(1)
    await act(async () => { vi.advanceTimersByTime(CROSS_FADE_MS + 200) })
    expect([...frames.querySelectorAll('img')].map(layer => layer.dataset.layer)).toEqual(['shown'])
  })

  it('replaces the picture at once under reduced motion', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    render(<VisualCard visual={visual()} />)
    const card = screen.getByRole('region', { name: 'Visual: How a draft is sent' })
    await within(card).findByRole('img')
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }))
    expect([...card.querySelectorAll('.visual-card__frames img')].map(layer => (layer as HTMLElement).dataset.layer)).toEqual(['shown'])
  })

  it('stays on its step when the card is drawn again, as when its turn folds', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    const value = visual()
    const first = render(<VisualCard visual={value} />)
    await screen.findByRole('img')
    await userEvent.click(screen.getByRole('button', { name: 'Step 3' }))
    first.unmount()
    render(<VisualCard visual={value} />)
    expect(screen.getByRole('group', { name: 'Walkthrough' })).toHaveTextContent('Step 3 of 3')
    await userEvent.click(screen.getByRole('button', { name: 'Read all' }))
    cleanup()
    render(<VisualCard visual={value} />)
    expect(screen.getByRole('button', { name: 'Step through' })).toBeInTheDocument()
  })
})
