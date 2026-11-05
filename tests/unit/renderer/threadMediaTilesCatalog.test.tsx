/**
 * A tile's words come from the catalogs as a built app reads them (ADR-0123): compiled, with no message compiler loaded.
 * A message written with a `t` handed to a helper is never extracted, so a built app falls back to its English source
 * and warns on every render of every tile. That warning was most of what a step cost a turn with many pictures
 * (`docs/perf/2026-11-04-thread-pictures-cost.md`); this holds the tiles to none.
 */
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { compileMessage } from '@lingui/message-utils/compileMessage'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { interfaceCatalogs, type CompiledCatalog } from '../../../src/shared/interfaceCatalogLoader'
import { WRITTEN_STEP_PREFIX, type AgentActivity } from '../../../src/shared/agentActivity'
import type { ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'

vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' }))
import { ThreadMediaTiles } from '../../../src/renderer/src/agents/ThreadMediaTiles'

const { english } = interfaceCatalogs(
  import.meta.glob<CompiledCatalog>(['../../../src/locales/*/en.po', '!../../../src/locales/main/en.po'], { eager: true }),
  import.meta.glob<CompiledCatalog>(['../../../src/locales/*/*.po', '!../../../src/locales/main/*.po', '!../../../src/locales/*/en.po']),
)
const media = (index: number) => ({ id: `m${index}`, digest: String(index).repeat(64), kind: 'image' as const, mimeType: 'image/png' as const, sizeBytes: 40,
  width: 1280, height: 800, name: `shot-${index}.png`, source: 'tool' as const })
const records: AgentActivity[] = [
  { id: 'claude-tool-shot', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'sotto_browser / screenshot', media: [media(0), media(1)] },
  { id: `${WRITTEN_STEP_PREFIX}turn`, turnId: 'turn', sequence: 1, kind: 'file-change', status: 'completed', title: 'written', media: [media(2)] },
]
const groups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records }] as unknown as ActivityGroup[]

describe('a tile\'s words in a built app', () => {
  beforeAll(() => {
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia: async () => ({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }) } }
    // As a built app runs: the catalogs compiled ahead, and no compiler for anything they lack.
    i18n.setMessagesCompiler(undefined as unknown as typeof compileMessage)
    i18n.loadAndActivate({ locale: 'en', messages: english })
  })
  afterAll(() => {
    cleanup()
    i18n.setMessagesCompiler(compileMessage)
    delete (window as unknown as { sotto?: unknown }).sotto
  })

  it('names every tile and its step from the catalogs, and warns of no message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<ThreadMediaTiles groups={groups} threadId="thread" />)
    await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(3))
    expect(screen.getByText('Picture 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open picture 3 of 3, from Pictures and videos it wrote' })).toBeTruthy()
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith('Uncompiled message'))).toEqual([])
    warn.mockRestore()
  })
})
