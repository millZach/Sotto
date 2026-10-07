import React, { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageContent } from '../../../src/renderer/src/agents/MessageContent'
import type { DiagramRenderResult } from '../../../src/renderer/src/agents/diagrams/diagramRenderer'

const renderer = vi.hoisted(() => ({ renderDiagram: vi.fn<(code: string) => Promise<DiagramRenderResult>>() }))
vi.mock('../../../src/renderer/src/agents/diagrams/diagramRenderer', () => renderer)

const DRAWING: DiagramRenderResult = { ok: true, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', width: 400, height: 200, title: 'Login', description: 'You sign in and get a token.' }
const SEQUENCE = 'sequenceDiagram\n  accTitle: Login\n  You->>Sotto: Sign in'
const fence = (source: string, closed = true): string => ['Before', '', '```mermaid', source, ...(closed ? ['```'] : [])].join('\n')

beforeEach(() => {
  renderer.renderDiagram.mockReset()
  renderer.renderDiagram.mockResolvedValue(DRAWING)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { sotto?: unknown }).sotto
})

describe('diagrams in answers', () => {
  it('draws a complete diagram as a named image with its description, never as live markup', async () => {
    const { container } = render(<MessageContent text={fence(SEQUENCE)} />)
    const image = await screen.findByRole('img', { name: 'Sequence diagram: Login' })
    expect(image).toHaveAttribute('src', DRAWING.ok && DRAWING.dataUrl)
    expect(image).toHaveAccessibleDescription('You sign in and get a token.')
    expect(screen.getByRole('figure', { name: 'Sequence diagram: Login' })).toHaveAttribute('data-state', 'drawn')
    expect(renderer.renderDiagram).toHaveBeenCalledWith(SEQUENCE, expect.objectContaining({ dark: true }))
    expect(container.querySelector('svg:not(.lucide), script, foreignObject')).toBeNull()
  })

  it('shows a streaming diagram as source until its fence closes, then draws it', async () => {
    const { rerender } = render(<MessageContent text={fence('flowchart TD\n  A --> B', false)} streaming />)
    expect(screen.getByText('Draws when the block is complete.')).toBeInTheDocument()
    expect(screen.getByLabelText('Flowchart source')).toHaveTextContent('A --> B')
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull()
    expect(renderer.renderDiagram).not.toHaveBeenCalled()
    rerender(<MessageContent text={`${fence('flowchart TD\n  A --> B')}\n\nStill writing`} streaming />)
    expect(await screen.findByRole('img', { name: 'Flowchart: Login' })).toBeInTheDocument()
    expect(renderer.renderDiagram).toHaveBeenCalledTimes(1)
  })

  it('keeps unsupported, oversized and failed diagrams readable with a reason', async () => {
    renderer.renderDiagram.mockResolvedValue({ ok: false, reason: 'The source has a syntax error on line 2.' })
    render(<MessageContent text={[fence('flowchart TD\n  A[oops'), '', '```mermaid', 'gantt\n  title Plan', '```'].join('\n')} />)
    expect(await screen.findByText("Couldn't draw this diagram. The source has a syntax error on line 2.")).toBeInTheDocument()
    expect(screen.getByLabelText('Flowchart source')).toHaveTextContent('A[oops')
    expect(screen.getByText("Sotto doesn't draw “gantt” diagrams. Sequence, flow, state, class and entity diagrams are drawn.")).toBeInTheDocument()
    for (const figure of screen.getAllByRole('figure')) expect(figure).toHaveAttribute('data-state', 'failed')
    expect(renderer.renderDiagram).toHaveBeenCalledTimes(1)
    cleanup()
    render(<MessageContent text={fence(`flowchart TD\n${'  A --> B\n'.repeat(1_400)}`)} />)
    expect(screen.getByText('Too long to draw. Diagrams over 12,000 characters are shown as source.')).toBeInTheDocument()
    expect(renderer.renderDiagram).toHaveBeenCalledTimes(1)
  })

  it('copies the exact source through the main output path and toggles to source', async () => {
    const user = userEvent.setup()
    const deliverOutput = vi.fn<NonNullable<Window['sotto']>['deliverOutput']>().mockResolvedValue('copied')
    Object.defineProperty(window, 'sotto', { configurable: true, value: { deliverOutput } })
    render(<MessageContent text={fence(SEQUENCE)} />)
    await screen.findByRole('img', { name: 'Sequence diagram: Login' })
    await user.click(screen.getByRole('button', { name: 'Copy diagram source' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(deliverOutput).toHaveBeenCalledWith({ text: SEQUENCE, autoPaste: false, pasteDelayMs: 50 })
    const toggle = screen.getByRole('button', { name: 'Show source' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Sequence diagram source')).toHaveTextContent('You->>Sotto: Sign in')
    expect(screen.queryByRole('img', { name: 'Sequence diagram: Login' })).toBeNull()
    await user.click(toggle)
    expect(screen.getByRole('img', { name: 'Sequence diagram: Login' })).toBeInTheDocument()
  })

  it('expands into a viewer that zooms, pans, fits from the keyboard and returns focus on close', async () => {
    const user = userEvent.setup()
    render(<MessageContent text={fence(SEQUENCE)} />)
    await screen.findByRole('img', { name: 'Sequence diagram: Login' })
    const expand = screen.getByRole('button', { name: 'Expand diagram' })
    await user.click(expand)
    const viewer = screen.getByRole('dialog', { name: 'Sequence diagram: Login' })
    const view = within(viewer).getByRole('group', { name: 'Diagram view' })
    await waitFor(() => expect(view).toHaveFocus())
    const zoom = within(viewer).getByLabelText('Zoom')
    const fit = within(viewer).getByRole('button', { name: 'Fit to window' })
    const start = zoom.textContent
    expect(fit).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(view, { key: '+' })
    expect(zoom.textContent).not.toBe(start)
    expect(fit).toHaveAttribute('aria-pressed', 'false')
    const image = within(viewer).getByRole('img')
    const before = image.style.transform
    fireEvent.keyDown(view, { key: 'ArrowLeft' })
    expect(image.style.transform).not.toBe(before)
    fireEvent.keyDown(view, { key: '0' })
    expect(zoom.textContent).toBe(start)
    expect(fit).toHaveAttribute('aria-pressed', 'true')
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(view, { key: '-' })
    expect(within(viewer).getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(within(viewer).getByRole('button', { name: 'Close diagram' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(expand).toHaveFocus())
  })

  it('closes the viewer on Escape through the dialog cancel event', async () => {
    const user = userEvent.setup()
    render(<MessageContent text={fence(SEQUENCE)} />)
    await screen.findByRole('img', { name: 'Sequence diagram: Login' })
    await user.click(screen.getByRole('button', { name: 'Expand diagram' }))
    const viewer = screen.getByRole('dialog')
    act(() => { viewer.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mounts a diagram it has already drawn as its drawing, in one commit', async () => {
    const source = 'stateDiagram-v2\n  accTitle: Login\n  Idle --> Signed'
    const first = render(<MessageContent text={fence(source)} />)
    await screen.findByRole('img', { name: 'State diagram: Login' })
    first.unmount()

    let commits = 0
    render(<Profiler id="answer" onRender={() => { commits += 1 }}><MessageContent text={fence(source)} /></Profiler>)
    // Synchronously, before any renderer promise settles: the image, not the source and "Drawing…".
    expect(screen.getByRole('figure', { name: 'State diagram: Login' })).toHaveAttribute('data-state', 'drawn')
    expect(screen.queryByText('Drawing…')).toBeNull()
    await waitFor(() => expect(renderer.renderDiagram).toHaveBeenCalledTimes(2))
    await act(async () => Promise.resolve())
    // The renderer still confirms the drawing, and the confirmation changes nothing on screen.
    expect(commits).toBe(1)
    expect(screen.getByRole('img', { name: 'State diagram: Login' })).toHaveAttribute('src', DRAWING.ok && DRAWING.dataUrl)
  })

  it('never mounts a failed diagram as drawn, so the next view asks again', async () => {
    const source = 'flowchart TD\n  accTitle: Retry\n  A --> B'
    renderer.renderDiagram.mockResolvedValue({ ok: false, reason: 'Took too long to draw.' })
    const first = render(<MessageContent text={fence(source)} />)
    expect(await screen.findByText("Couldn't draw this diagram. Took too long to draw.")).toBeInTheDocument()
    first.unmount()

    renderer.renderDiagram.mockResolvedValue(DRAWING)
    render(<MessageContent text={fence(source)} />)
    expect(screen.getByText('Drawing…')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'Flowchart: Login' })).toBeInTheDocument()
    expect(renderer.renderDiagram).toHaveBeenCalledTimes(2)
  })
})
