// @vitest-environment node
import { preloadElectron } from '../../fixtures/preloadElectron'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { VISUAL_PAGE_OPEN, type VisualPageRequest } from '../../../src/shared/visualPages'

const theme = { mode: 'dark', reducedMotion: false, tokens: Object.fromEntries(['--sotto-text', '--sotto-muted', '--sotto-line', '--sotto-background', '--sotto-surface',
  '--sotto-border', '--sotto-group-fill', '--sotto-note-fill', '--sotto-accent'].map(name => [name, '#123456'])) } as VisualPageRequest['theme']

describe('interactive visual preload contract (ADR-0060)', () => {
  it('lets the main window ask for a page by thread and visual, never send one, and checks the answer', async () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'win32').visuals!
    expect(Object.keys(bridge)).toEqual(['open'])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('visuals')
    ipc.invoke.mockResolvedValue({ ok: true, url: 'sotto-visual://page/abc' })
    expect(await bridge.open({ threadId: 'thread', visualId: 'v1', theme })).toEqual({ ok: true, url: 'sotto-visual://page/abc' })
    expect(ipc.invoke).toHaveBeenCalledWith(VISUAL_PAGE_OPEN, { threadId: 'thread', visualId: 'v1', theme })
    expect(() => bridge.open({ threadId: 'thread', visualId: 'v1', theme, source: '<h1>Hi</h1>' } as VisualPageRequest)).toThrow()
    ipc.invoke.mockResolvedValue({ ok: true, url: 'https://example.com/' })
    await expect(bridge.open({ threadId: 'thread', visualId: 'v1', theme })).rejects.toThrow()
  })
})
