import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EffortPicker } from '../../../src/renderer/src/agents/EffortPicker'
import { SplitChipEffort } from '../../../src/renderer/src/agents/SplitChipEffort'
import { effortChoices, ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'
import { ULTRACODE, withUltracode } from '../../../src/shared/ultracode'
import type { AgentState } from '../../../src/shared/agents'
import { fixture, mount, setupThreadOptionsTests } from '../../fixtures/renderer/threadOptionsHarness'
import { EffortTrace } from '../../../src/renderer/src/agents/EffortTrace'
import { startWindowVisibility } from '../../../src/renderer/src/state/windowVisibility'

/**
 * The composer's trace (ADR-0019, October 26 amendment): a glow travels round the composer while the thread is set to
 * its model's top level, or to Max under a level past it, and nowhere else. It must stay cheap on main: only a
 * transform turns, motion stops under reduced motion and in a window nobody can see.
 */
const levels = (...ids: string[]) => ids.map(id => ({ id, label: id }))
const traceMark = (value: string, options: ReturnType<typeof levels>): string | null => {
  const { container } = render(<EffortPicker value={value} options={options} disabled={false} onChange={() => {}} />)
  return container.querySelector('.effort-picker-anchor')!.getAttribute('data-effort-trace')
}
/** The harness's state with Claude's model offering Ultracode past Max, as the catalog reports a model with Extra high. */
function claudeState(reasoningEffort: string): AgentState {
  const state = fixture({ reasoningEffort })
  state.host.models.find(model => model.id === 'claude:model')!.reasoningEfforts = withUltracode(['low', 'medium', 'high', 'xhigh', 'max'])
  return state
}
/** The composer every thread and Watcher draws (ADR-0168, ADR-0172): its effort word carries the trace's mark. */
function mountComposer(state: AgentState, watcher = false): void {
  render(<form className="thread-prompt" data-quiet="true"><EffortTrace />
    <ThreadOptions thread={state.host.threads[0]!} state={state} command={async () => state} watcher={watcher} quiet={{ effortScore: 0, shieldSlot: null }} /></form>)
}
const wordTrace = (): string | null => screen.getByRole('combobox', { name: 'Thread reasoning' }).closest('[data-effort-trace]')?.getAttribute('data-effort-trace') ?? null
const composerTrace = (): string | null => screen.getByRole('combobox', { name: 'Thread reasoning' }).closest('.effort-picker-anchor')!.getAttribute('data-effort-trace')
const css = readFileSync(join(process.cwd(), 'src/renderer/src/agents/effortTrace.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')

setupThreadOptionsTests()
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-window-hidden') })

describe('the effort trace', () => {
  it('marks the top level and Max, and nothing below them', () => {
    expect(traceMark('xhigh', levels('low', 'medium', 'high', 'xhigh'))).toBe('true')
    expect(traceMark('max', levels('low', 'medium', 'high', 'xhigh', 'max'))).toBe('true')
    expect(traceMark('high', levels('low', 'medium', 'high', 'xhigh', 'max'))).toBe('false')
    expect(traceMark('xhigh', levels('low', 'medium', 'high', 'xhigh', 'max'))).toBe('false')
    // A model that reports one level has no highest level.
    expect(traceMark('max', levels('max'))).toBe('false')
  })

  it('keeps Max lit when a level sits past it, and lights that level too', () => {
    expect(traceMark('max', levels('low', 'medium', 'high', 'xhigh', 'max', 'ultracode'))).toBe('true')
    expect(traceMark('ultracode', levels('low', 'medium', 'high', 'xhigh', 'max', 'ultracode'))).toBe('true')
    expect(traceMark('xhigh', levels('low', 'medium', 'high', 'xhigh', 'max', 'ultracode'))).toBe('false')
  })

  it('lights a thread composer at Ultracode, the real level past Max, and keeps Max lit under it (ADR-0148)', () => {
    for (const [level, lit] of [[ULTRACODE, 'true'], ['max', 'true'], ['xhigh', 'false'], ['high', 'false']] as const) {
      mount(claudeState(level))
      expect(composerTrace(), level).toBe(lit)
      cleanup()
    }
  })

  it('lights Watcher’s composer word at Max and not below it', () => {
    const model = claudeState('max').host.models.find(entry => entry.id === 'claude:model')
    const watcherLevels = effortChoices(model, 'max', { ultracode: false })
    expect(watcherLevels.map(option => option.id)).not.toContain(ULTRACODE)
    expect(traceMark('max', watcherLevels.map(option => ({ id: option.id, label: option.label })))).toBe('true')
  })

  it('lights the thread composer’s effort word at Max and at Ultracode, and nowhere below', () => {
    for (const [level, lit] of [[ULTRACODE, 'true'], ['max', 'true'], ['xhigh', 'false'], ['high', 'false']] as const) {
      mountComposer(claudeState(level))
      expect(wordTrace(), level).toBe(lit)
      cleanup()
    }
  })

  it('lights the thread composer at the top level of a provider with no Max', () => {
    for (const [level, lit] of [['xhigh', 'true'], ['high', 'false']] as const) {
      const state = fixture({ providerId: 'codex', modelId: 'codex:model', reasoningEffort: level })
      state.host.models.find(model => model.id === 'codex:model')!.reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh']
      mountComposer(state)
      expect(wordTrace(), level).toBe(lit)
      cleanup()
    }
  })

  it('lights Watcher’s composer at Max, its top level, since Watcher is never offered Ultracode', () => {
    mountComposer(claudeState('max'), true)
    expect(wordTrace()).toBe('true')
    cleanup()
    mountComposer(claudeState('xhigh'), true)
    expect(wordTrace()).toBe('false')
  })

  it('lets the effort word light the composer it sits in', () => {
    const { container } = render(<SplitChipEffort levels={['low', 'medium', 'high', 'xhigh', 'max', ULTRACODE]} value="max" disabled={false} suggestion={null} onChange={() => {}} />)
    expect(container.querySelector('[data-effort-trace]')?.getAttribute('data-effort-trace')).toBe('true')
    expect(css).toMatch(/\.thread-prompt:has\(\[data-effort-trace='true'\]\) > \.effort-trace \{ display: block; \}/u)
  })

  it('draws a halo and a head, hidden from speech, and nothing unless the effort chip asks for it', () => {
    const { container } = render(<EffortTrace />)
    const trace = container.querySelector('.effort-trace')!
    expect(trace.getAttribute('aria-hidden')).toBe('true')
    expect(trace.querySelectorAll(':scope > .effort-trace__halo .effort-trace__light, :scope > .effort-trace__line .effort-trace__light')).toHaveLength(2)
    expect(css).toMatch(/\.effort-trace \{ display: none;/u)
  })

  it('turns by transform alone, under motion only, and pauses in a hidden window', () => {
    const turn = /@keyframes effort-trace-turn \{(?:[^{}]|\{[^{}]*\})*\}/u.exec(css)?.[0] ?? ''
    expect(turn).not.toBe('')
    for (const [, body = ''] of turn.matchAll(/\{([^{}]*)\}/gu)) expect(body.trim(), 'a property other than transform repaints on main').toMatch(/^transform: rotate\([^)]*\);$/u)
    const runs = [...css.matchAll(/([^{}]+)\{[^{}]*animation: effort-trace-turn/gu)].map(match => match[1]!.trim())
    expect(runs).toEqual([":root:not([data-reduced-motion='on']) .effort-trace__light"])
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*:root:not\(\[data-reduced-motion='on'\]\) \.effort-trace__light \{ animation: effort-trace-turn/u)
    expect(css).toMatch(/:root\[data-window-hidden\] \.effort-trace__light \{ animation-play-state: paused; \}/u)
  })

  it('marks the window root while the page or main says the window is hidden', () => {
    let state: DocumentVisibilityState = 'visible'
    let tell: (visible: boolean) => void = () => {}
    let listening = false
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    const stop = startWindowVisibility(document.documentElement, listener => { tell = listener; listening = true; return () => { listening = false } })
    const hidden = (): boolean => document.documentElement.hasAttribute('data-window-hidden')
    try {
      expect(hidden()).toBe(false)
      state = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      expect(hidden()).toBe(true)
      state = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      expect(hidden()).toBe(false)
      // Started minimized: the page says visible, main says nobody can see it, until the window is shown.
      tell(false)
      expect(hidden()).toBe(true)
      tell(true)
      expect(hidden()).toBe(false)
    } finally {
      stop()
      expect(listening).toBe(false)
      delete (document as { visibilityState?: unknown }).visibilityState
      if (descriptor) Object.defineProperty(Document.prototype, 'visibilityState', descriptor)
    }
  })
})
