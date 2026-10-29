import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { carries, checkTipSources, pageText, reportMarkdown, TIP_SOURCES_PATH } from '../../../scripts/check-tip-sources.mjs'

const source = (phrase: string, url = 'https://docs.example/page') => ({ provider: 'claude', url, phrase, checked: '2026-10-28' })

describe('the weekly tip source check (ADR-0159)', () => {
  it('reads a page’s words without its markup, scripts, entities or curly quotes', () => {
    const html = '<html><script>var x = "Claude reads"</script><p>Claude&nbsp;reads <b>them</b> at the\n start of every&#32;session.</p><p>It&rsquo;s “plain”.</p></html>'
    expect(pageText(html)).toBe('Claude reads them at the start of every session. It\'s "plain".')
    expect(carries(html, 'claude reads them at the start of every session')).toBe(true)
    expect(carries(html, 'var x')).toBe(false)
  })

  it('reports a page that lost its sentence or is gone, and only warns about one it could not reach', async () => {
    const pages: Record<string, { status: number; text: string } | Error> = {
      'https://docs.example/kept': { status: 200, text: '<p>Codex reads AGENTS.md files before doing any work.</p>' },
      'https://docs.example/reworded': { status: 200, text: '<p>Codex loads instructions first.</p>' },
      'https://docs.example/gone': { status: 404, text: 'Not found' },
      'https://docs.example/down': { status: 503, text: '' },
      'https://docs.example/offline': new Error('fetch failed'),
    }
    const phrase = 'Codex reads AGENTS.md files before doing any work'
    const { reported, warned } = await checkTipSources({
      kept: source(phrase, 'https://docs.example/kept'),
      reworded: source(phrase, 'https://docs.example/reworded'),
      gone: source(phrase, 'https://docs.example/gone'),
      down: source(phrase, 'https://docs.example/down'),
      offline: source(phrase, 'https://docs.example/offline'),
    }, async url => { const page = pages[url]!; if (page instanceof Error) throw page; return page })
    expect(reported.map(item => [item.id, item.reason])).toEqual([['reworded', 'missing'], ['gone', 'gone']])
    expect(warned.map(item => item.id)).toEqual(['down', 'offline'])
    const report = reportMarkdown(reported)
    expect(report).toContain('`reworded` (claude): the page no longer says “Codex reads AGENTS.md files before doing any work”.')
    expect(report).toContain('`gone` (claude): the page is gone')
  })

  it('checks the sources the app ships', async () => {
    const shipped = JSON.parse(await readFile(TIP_SOURCES_PATH, 'utf8')) as Record<string, unknown>
    expect(Object.keys(shipped).length).toBeGreaterThan(0)
  })
})
