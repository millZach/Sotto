// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { browserRequestText } from '../../../src/main/agents/browserRequests'

// What a provider's own permission asks in words when an agent reaches for Sotto's browser (ADR-0220's tools included).
describe('browser request words for the full catalog', () => {
  it('names every new action and tool in plain words', () => {
    const words = (action: Record<string, unknown>) => browserRequestText('mcp__sotto_browser__browser_action', { action })!.split('\n')[0]
    expect(words({ type: 'snapshot' })).toBe('Use Sotto’s browser to read the page.')
    expect(words({ type: 'hover', ref: 'e1' })).toBe('Use Sotto’s browser to point at something in the page.')
    expect(words({ type: 'select', selector: '#a', values: ['x'] })).toBe('Use Sotto’s browser to choose in a menu in the page.')
    expect(words({ type: 'upload', paths: ['a.txt'] })).toBe('Use Sotto’s browser to give the page files from this computer.')
    expect(words({ type: 'evaluate', expression: '1' })).toBe('Use Sotto’s browser to run a script in the page.')
    expect(words({ type: 'record_start' })).toBe('Use Sotto’s browser to record the page to a video.')
    expect(browserRequestText('mcp__sotto_browser__browser_close', { pageId: 'x' })!.split('\n')[0]).toBe('Use Sotto’s browser to close a page it opened.')
    expect(browserRequestText('mcp__sotto_browser__browser_servers', {})!.split('\n')[0]).toBe('Use Sotto’s browser to list the web servers started from Sotto on this computer.')
    expect(browserRequestText('mcp__sotto_browser__browser_open', { port: 5173, description: 'Dev server' })).toContain('Use Sotto’s browser to open the server on localhost:5173.\n“Dev server”')
  })
})
