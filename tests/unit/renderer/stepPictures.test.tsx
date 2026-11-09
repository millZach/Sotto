import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'

const owl = { on: true }
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' && owl.on }))
import { PictureScopeContext, StepPicturesThreadContext, useStepPictures } from '../../../src/renderer/src/agents/StepPictures'

const TILE = 'data:image/jpeg;base64,/9j/4AAQ'
const WHOLE = 'data:image/png;base64,iVBORw0KGgo='
const picture = (index: number) => ({ id: `m${index}`, digest: String(index % 10).repeat(64), kind: 'image' as const, mimeType: 'image/png' as const, sizeBytes: 40,
  width: 1280, height: 800, name: `shot-${index}.png`, source: 'tool' as const })
const step = (id: string, pictures: number, extra: Partial<AgentActivity> = {}): AgentActivity =>
  ({ id, turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: `Step ${id}`, media: Array.from({ length: pictures }, (_, index) => picture(index)), ...extra })

/** A line's pictures, at its end and under it, as a row draws them. */
function Line({ records, visible }: { readonly records: readonly AgentActivity[]; readonly visible?: boolean }): React.ReactNode {
  const { strip, player } = useStepPictures(records, visible)
  return <div data-testid="line">{strip}{player}</div>
}
const inThread = (node: React.ReactNode, scope?: readonly AgentActivity[]) => render(<StepPicturesThreadContext.Provider value={{ threadId: 'thread', who: 'Claude Code' }}>
  {scope ? <PictureScopeContext.Provider value={{ records: scope }}>{node}</PictureScopeContext.Provider> : node}
</StepPicturesThreadContext.Provider>)

class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void { this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve(): void { /* nothing held */ }
  disconnect(): void { /* nothing held */ }
}

describe('an agent\'s pictures in its steps (ADR-0170, pictures in steps)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => {
    globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia } }
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })
  afterEach(() => { cleanup(); owl.on = true; threadMedia.mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real; delete (window as unknown as { sotto?: unknown }).sotto; vi.restoreAllMocks() })

  it('shows the newest three of a line\'s pictures, small, with a count for the rest, each read at tile size by its handle', async () => {
    inThread(<Line records={[step('a', 3), step('b', 2)]} />)
    expect(screen.getByRole('group', { name: 'Pictures: 5' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open all 5 pictures' }).textContent).toBe('+2')
    expect(screen.getAllByRole('button', { name: /^Open picture/ }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Open picture 3 of 5, from Step a', 'Open picture 4 of 5, from Step b', 'Open picture 5 of 5, from Step b'])
    await waitFor(() => expect(document.querySelectorAll('.step-pictures__thumb img[src]')).toHaveLength(3))
    expect(threadMedia).toHaveBeenCalledTimes(3)
    expect(threadMedia).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'b', mediaId: 'm1', size: 'tile', scale: 1 })
  })

  it('leaves out the pictures that stand in the thread: shown through sotto_media, or an image the user asked for', async () => {
    const { container } = inThread(<Line records={[step('sotto-shown-1', 2), step('codex-image', 1, { generates: 'image' })]} />)
    await act(async () => undefined)
    expect(container.querySelector('.step-pictures')).toBeNull()
    expect(threadMedia).not.toHaveBeenCalled()
  })

  it('opens the viewer on the picture pressed, stepping through the pictures of the work around the line', async () => {
    const line = step('b', 1)
    inThread(<Line records={[line]} />, [step('a', 2), line, step('sotto-shown-1', 1)])
    await userEvent.click(screen.getByRole('button', { name: 'Open picture 1 of 1, from Step b' }))
    await waitFor(() => expect(threadMedia).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'b', mediaId: 'm0', size: 'full' }))
    const viewer = screen.getByRole('dialog')
    // Two pictures of step a, then this one: the third of three, the shown one being a tile of its own.
    expect(viewer.textContent).toContain('Picture 3')
    expect(viewer.textContent).not.toContain('Picture 4')
  })

  it('opens the viewer from the count at the first picture it stands for', async () => {
    inThread(<Line records={[step('a', 5)]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open all 5 pictures' }))
    await waitFor(() => expect(threadMedia).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'a', mediaId: 'm0', size: 'full' }))
    expect(screen.getByRole('dialog').textContent).toContain('Picture 1')
  })

  it('plays a video in a tile under the line when its mark is pressed, and takes it away when pressed again', async () => {
    const video = { id: 'm0', digest: 'a'.repeat(64), kind: 'video' as const, mimeType: 'video/webm' as const, sizeBytes: 14_200_000, name: 'signup.webm', source: 'file' as const }
    inThread(<Line records={[{ ...step('sotto-written-1', 0), kind: 'file-change', media: [video] }]} />)
    const mark = screen.getByRole('button', { name: 'Play video 1 of 1, from Pictures and videos it wrote' })
    expect(document.querySelector('video')).toBeNull()
    await userEvent.click(mark)
    expect(mark.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('video')?.getAttribute('src')).toBe('sotto-media://video/thread/sotto-written-1/m0')
    await userEvent.click(mark)
    expect(document.querySelector('video')).toBeNull()
    expect(threadMedia).not.toHaveBeenCalled()
  })

  it('hides its strip while the line does not show it, and draws nothing with the Owl feature off or outside a thread', async () => {
    const { container, unmount } = inThread(<Line records={[step('a', 2)]} visible={false} />)
    expect(container.querySelector('.step-pictures')).toBeNull()
    unmount()
    owl.on = false
    const off = inThread(<Line records={[step('a', 2)]} />)
    expect(off.container.querySelector('.step-pictures')).toBeNull()
    off.unmount()
    owl.on = true
    const outside = render(<Line records={[step('a', 2)]} />)
    await act(async () => undefined)
    expect(outside.container.querySelector('.step-pictures')).toBeNull()
    expect(threadMedia).not.toHaveBeenCalled()
  })
})
