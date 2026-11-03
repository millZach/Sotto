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

/**
 * Observers a test moves: each tile starts near and on screen, and `leave` takes it off screen while it stays near. The
 * tiles share one of each per page for as long as the page lasts, so the list outlives a test.
 */
class SteeredObserver {
  static made: SteeredObserver[] = []
  readonly targets: Element[] = []
  constructor(private readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { SteeredObserver.made.push(this) }
  observe(target: Element): void { this.targets.push(target); this.report(target, true) }
  unobserve(target: Element): void { this.targets.splice(this.targets.indexOf(target), 1) }
  disconnect(): void { /* nothing held */ }
  report(target: Element, isIntersecting: boolean): void { this.callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  /** Off screen: the observer with no margin says so, and the near one does not. */
  static leave(): void { for (const observer of SteeredObserver.made) if (!observer.options?.rootMargin) for (const target of observer.targets) observer.report(target, false) }
}

describe('a video and a GIF an agent wrote (ADR-0170, part 4)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : 'data:image/gif;base64,R0lGODlh' }))
  const play = vi.fn(function (this: HTMLMediaElement) { this.dispatchEvent(new Event('play')); return Promise.resolve() })
  const pause = vi.fn()
  beforeAll(() => {
    globalThis.IntersectionObserver = SteeredObserver as unknown as typeof IntersectionObserver
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia } }
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  })
  afterEach(() => { cleanup(); threadMedia.mockClear(); play.mockClear(); pause.mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real; delete (window as unknown as { sotto?: unknown }).sotto; vi.restoreAllMocks() })
  const video = { id: 'm0', digest: 'a'.repeat(64), kind: 'video' as const, mimeType: 'video/webm' as const, sizeBytes: 14_200_000, name: 'signup.webm', source: 'file' as const }
  const gif = { id: 'm1', digest: 'b'.repeat(64), kind: 'image' as const, mimeType: 'image/gif' as const, sizeBytes: 900, width: 320, height: 200, name: 'spinner.gif', source: 'file' as const }
  // The host's English title is not what the window says: a step Sotto made is named in the window's own words.
  const written: AgentActivity = { id: 'sotto-written-1', turnId: 'turn', sequence: 2, kind: 'file-change', status: 'completed', title: 'Host words', media: [video, gif] }
  const writtenGroups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records: [written] }] as unknown as ActivityGroup[]

  it('shows a video\'s first frame without playing it, plays it only when pressed, and pauses it the moment it leaves the screen', async () => {
    render(<ThreadMediaTiles groups={writtenGroups} threadId="thread" />)
    expect(screen.getByText('Video 1')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Video 1 of 1, from Pictures and videos it wrote' })).toBeTruthy()
    expect(screen.getByText('WebM · 14 MB')).toBeTruthy()
    const player = document.querySelector('video')!
    expect(player.getAttribute('src')).toBe('sotto-media://video/thread/sotto-written-1/m0')
    expect(player.getAttribute('preload')).toBe('metadata')
    expect(player.autoplay).toBe(false)
    expect(player.hasAttribute('controls')).toBe(false)
    expect(play).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Play video 1' }))
    expect(play).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelector('video')!.hasAttribute('controls')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Play video 1' })).toBeNull()
    // The keyboard moves on to the player, whose controls take over from the button.
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('video')))
    act(() => SteeredObserver.leave())
    expect(pause).toHaveBeenCalled()
    // A video is played in its tile, never read as a picture.
    expect(threadMedia).not.toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'm0' }))
  })

  it('says a video could not play rather than showing nothing', async () => {
    render(<ThreadMediaTiles groups={writtenGroups} threadId="thread" />)
    act(() => { document.querySelector('video')!.dispatchEvent(new Event('error')) })
    expect(screen.getByText('Could not play. The file may have changed or been removed on its computer. Ask the agent to write it again.')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
  })

  it('shows a GIF still, plays it whole only when asked, and stops it when it leaves the screen', async () => {
    render(<ThreadMediaTiles groups={writtenGroups} threadId="thread" />)
    await waitFor(() => expect(document.querySelector('.thread-media img')?.getAttribute('src')).toBe(TILE))
    expect(threadMedia).not.toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'm1', size: 'full' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play GIF 1' }))
    await waitFor(() => expect(document.querySelector('.thread-media img')?.getAttribute('src')).toBe('data:image/gif;base64,R0lGODlh'))
    expect(screen.getByRole('button', { name: 'Stop GIF 1' }).getAttribute('aria-pressed')).toBe('true')
    act(() => SteeredObserver.leave())
    await waitFor(() => expect(document.querySelector('.thread-media img')?.getAttribute('src')).toBe(TILE))
    // The viewer steps through the pictures alone.
    expect(screen.getByRole('list', { name: '2 pictures' })).toBeTruthy()
  })
})
