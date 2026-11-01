import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'

const owl = { on: true }
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' && owl.on }))
import { mediaDetails, ThreadMediaTiles } from '../../../src/renderer/src/agents/ThreadMediaTiles'

const TILE = 'data:image/jpeg;base64,/9j/4AAQ'
const WHOLE = 'data:image/png;base64,iVBORw0KGgo='
const media = (index: number) => ({ id: `m${index}`, digest: String(index).repeat(64), kind: 'image' as const, mimeType: 'image/png' as const, sizeBytes: 40, width: 1280, height: 800, name: `picture-${index + 1}.png`, source: 'tool' as const })
const record: AgentActivity = { id: 'claude-tool-shot', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'sotto_browser / screenshot', media: [media(0), media(1)] }
const groups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records: [record] }] as unknown as ActivityGroup[]

/** Every tile is near at once: the observer reports each target as it is observed. */
class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void { this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve(): void { /* nothing held */ }
  disconnect(): void { /* nothing held */ }
}

describe('an agent\'s pictures in a turn (ADR-0170)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => {
    globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia } }
  })
  afterEach(() => { cleanup(); owl.on = true; threadMedia.mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real; delete (window as unknown as { sotto?: unknown }).sotto })

  it('shows a tile for each picture with its type and size, read at tile size by its handle', async () => {
    render(<ThreadMediaTiles groups={groups} threadId="thread" />)
    expect(screen.getByRole('list', { name: '2 pictures' })).toBeTruthy()
    expect(screen.getAllByText('PNG · 1280×800')).toHaveLength(2)
    await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(2))
    expect(threadMedia).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'claude-tool-shot', mediaId: 'm0', size: 'tile' })
  })

  it('opens the viewer on the picture pressed, reading it whole', async () => {
    render(<ThreadMediaTiles groups={groups} threadId="thread" />)
    await userEvent.click(screen.getByRole('button', { name: 'Open picture 2 of 2, from sotto_browser / screenshot' }))
    await waitFor(() => expect(threadMedia).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'claude-tool-shot', mediaId: 'm1', size: 'full' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('says a picture is no longer kept when its host has let it go', async () => {
    threadMedia.mockResolvedValue(null as never)
    render(<ThreadMediaTiles groups={[{ ...groups[0]!, records: [{ ...record, id: 'gone', media: [media(0)] }] }]} threadId="thread" />)
    await waitFor(() => expect(screen.getByText('No longer kept on its computer')).toBeTruthy())
    threadMedia.mockImplementation(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  })

  it('says a read failed, not that the picture is gone, and keeps nothing so it can try again', async () => {
    threadMedia.mockRejectedValueOnce(new Error('disconnected'))
    render(<ThreadMediaTiles groups={[{ ...groups[0]!, records: [{ ...record, id: 'flaky', media: [media(0)] }] }]} threadId="thread" />)
    await waitFor(() => expect(screen.getByText('Could not load. Nothing was lost. Scroll back to it to try again.')).toBeTruthy())
    cleanup()
    render(<ThreadMediaTiles groups={[{ ...groups[0]!, records: [{ ...record, id: 'flaky', media: [media(0)] }] }]} threadId="thread" />)
    await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(1))
  })

  it('plays the owl at the easel while an image is made, reading nothing, then shows the picture when it lands', async () => {
    const makingRecord: AgentActivity = { id: 'codex-image', turnId: 'turn', sequence: 1, kind: 'tool', status: 'running', title: 'Image', generates: 'image' }
    const making = [{ ...groups[0]!, records: [makingRecord] }] as unknown as ActivityGroup[]
    const { rerender } = render(<ThreadMediaTiles groups={making} threadId="thread" />)
    expect(screen.getByRole('img', { name: 'Making the image' })).toBeTruthy()
    expect(screen.getByText('It shows here when it is done')).toBeTruthy()
    // The scene's text is drawn, and the screen reader hears the tile's name, not the art.
    expect(document.querySelector('.owl-easel')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.owl-easel__sketch')?.textContent).toContain('(OvO)')
    expect(threadMedia).not.toHaveBeenCalled()
    rerender(<ThreadMediaTiles groups={[{ ...making[0]!, records: [{ ...makingRecord, status: 'completed', media: [{ ...media(0), source: 'generated' }] }] }] as unknown as ActivityGroup[]} threadId="thread" />)
    expect(document.querySelector('.owl-easel')).toBeNull()
    await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Open picture 1 of 1, from Image' })).toBeTruthy()
  })

  it('shows no tile for an image step that ended without a picture', () => {
    const failed: AgentActivity = { id: 'codex-image', turnId: 'turn', sequence: 1, kind: 'tool', status: 'failed', title: 'Image', generates: 'image' }
    const { container } = render(<ThreadMediaTiles groups={[{ ...groups[0]!, records: [failed] }] as unknown as ActivityGroup[]} threadId="thread" />)
    expect(container.innerHTML).toBe('')
  })

  it('draws nothing while the Owl feature is off, and reads nothing', async () => {
    owl.on = false
    const { container } = render(<ThreadMediaTiles groups={groups} threadId="thread" />)
    await act(async () => undefined)
    expect(container.innerHTML).toBe('')
    expect(threadMedia).not.toHaveBeenCalled()
  })

  it('names a picture by its type and size alone', () => {
    expect(mediaDetails(media(0))).toBe('PNG · 1280×800')
    expect(mediaDetails({ ...media(0), mimeType: 'image/webp', width: undefined, height: undefined })).toBe('WebP')
  })
})
