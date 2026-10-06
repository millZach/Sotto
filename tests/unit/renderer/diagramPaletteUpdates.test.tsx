import React, { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDiagramPalette } from '../../../src/renderer/src/agents/diagrams/diagramPalette'

const renderDiagram = vi.fn()
// The same palette dependency that MermaidDiagram uses to request an expensive redraw.
function DiagramConsumer() {
  const palette = useDiagramPalette()
  useEffect(() => { renderDiagram(palette) }, [palette])
  return null
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('style')
  vi.useRealTimers()
  vi.mocked(renderDiagram).mockClear()
})

describe('diagram palette updates', () => {
  it('keeps existing drawings during a color drag and redraws each once with the final palette', async () => {
    document.documentElement.style.setProperty('--tt-accent', '#112233')
    render(<><DiagramConsumer /><DiagramConsumer /></>)
    expect(renderDiagram).toHaveBeenCalledTimes(2)
    vi.mocked(renderDiagram).mockClear()
    vi.useFakeTimers()
    for (const color of ['#223344', '#334455', '#445566']) {
      await act(async () => { document.documentElement.style.setProperty('--tt-accent', color) })
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(renderDiagram).not.toHaveBeenCalled()
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(renderDiagram).toHaveBeenCalledTimes(2)
    for (const call of renderDiagram.mock.calls) expect(call[0]).toMatchObject({ accent: '#445566' })
    // Root mutations that do not change the drawing's palette never render it again.
    vi.mocked(renderDiagram).mockClear()
    await act(async () => { document.documentElement.style.setProperty('--unrelated-size', '20px') })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(renderDiagram).not.toHaveBeenCalled()
  })

  it('cancels a pending palette update when the diagram unmounts', async () => {
    const view = render(<DiagramConsumer />)
    expect(renderDiagram).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    await act(async () => { document.documentElement.style.setProperty('--tt-accent', '#445566') })
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
