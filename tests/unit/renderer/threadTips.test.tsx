import { promptText } from './helpers/promptEditor'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { OWL_FEATURES } from '../../../src/shared/owlFeatures'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { THREAD_SHORTCUT_IDS } from '../../../src/shared/threadShortcuts'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { chooseTip, forgetShownTips, TIP_CATALOG, tipCandidates, tipRotation, tipSources, type TipFacts } from '../../../src/renderer/src/agents/tips'
import { createTipsSetAsideStore, tipsSetAside } from '../../../src/renderer/src/agents/tipsSetAside'
import { ThreadTipsSetting } from '../../../src/renderer/src/features/settings/ThreadTipsSetting'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const owl = vi.hoisted(() => ({ tips: true }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'thread-tips' ? owl.tips : actual.useOwlFeature(id as never) }
})

const memory = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> & { readonly writes: string[] } => {
  const items = new Map<string, string>()
  const writes: string[] = []
  return { writes, getItem: key => items.get(key) ?? null, setItem: (key, value) => { writes.push(key); items.set(key, value) }, removeItem: key => { items.delete(key) },
    key: index => [...items.keys()][index] ?? null, get length() { return items.size } }
}

const facts = (patch: Partial<TipFacts> = {}): TipFacts => ({
  audience: 'thread', providerId: 'claude', platform: 'win32', settings: DEFAULT_SETTINGS, owl: () => true, skills: true, catalog: undefined, nextPrompts: true, ...patch,
})
const ids = (patch: Partial<TipFacts> = {}, setAside: ReadonlySet<string> = new Set()): string[] => tipCandidates(facts(patch), setAside).map(tip => tip.id)

const skill = (name: string, scope: AgentSkillCatalog['skills'][number]['scope'], description = `Does ${name}. More words.`): AgentSkillCatalog['skills'][number] =>
  ({ name, path: `claude-command:x:${name}`, description, scope, invocation: `/${name}` })

describe('which tips a working line can show', () => {
  it('gives a Claude thread Claude’s tips and Sotto’s, and never Codex’s', () => {
    const shown = ids()
    expect(shown).toContain('skills:claude')
    expect(shown).toEqual(expect.arrayContaining(['claude.claude-md', 'claude.subagents', 'sotto.next-waiting', 'sotto.dictate', 'sotto.stop-turn']))
    expect(shown.some(id => id.startsWith('codex.'))).toBe(false)
  })

  it('gives a Codex thread Codex’s tips and Sotto’s, and never Claude’s', () => {
    const shown = ids({ providerId: 'codex' })
    expect(shown).toEqual(expect.arrayContaining(['skills:codex', 'codex.agents-md', 'codex.skills-folder', 'sotto.next-waiting']))
    expect(shown.some(id => id.startsWith('claude.'))).toBe(false)
  })

  it('gives every other provider Sotto’s tips only', () => {
    for (const providerId of ['opencode', 'grok', 'cursor', 'devin', undefined]) {
      expect(ids({ providerId, skills: true }).every(id => id.startsWith('sotto.')), String(providerId)).toBe(true)
    }
  })

  it('gives Watcher Watcher’s tips and the ones that hold anywhere, never a provider’s or a thread shortcut’s', () => {
    const shown = ids({ audience: 'watcher', providerId: 'claude' })
    expect(shown).toEqual(['sotto.dictate', 'watcher.waiting', 'sotto.web-links', 'watcher.start-thread'])
  })

  it('names a skill from the catalog the user already loaded, the project’s own first, in place of the general skills tip', () => {
    const catalog = [skill('simplify', 'system'), skill('deploy', 'repo', 'Ship it to staging. Then check it.'), skill('mine', 'user'), { ...skill('hidden', 'repo'), userInvocable: false }]
    const tips = tipCandidates(facts({ catalog }), new Set())
    expect(tips[0]).toMatchObject({ id: 'skill:claude:deploy', skill: { name: 'deploy' } })
    expect(tips.map(tip => tip.id)).not.toContain('skills:claude')
    render(<>{tips[0]!.text}</>)
    expect(document.body).toHaveTextContent('/deploy in the prompt: Ship it to staging.')
    // A hidden skill tip moves on to the next skill.
    expect(tipCandidates(facts({ catalog }), new Set(['skill:claude:deploy']))[0]!.id).toBe('skill:claude:mine')
  })

  it('leaves out tips the user set aside, tips whose Owl feature is off, and shortcuts the user removed', () => {
    expect(ids({}, new Set(['sotto.dictate', 'skills:claude']))).not.toEqual(expect.arrayContaining(['sotto.dictate']))
    expect(ids({}, new Set(['skills:claude']))).not.toContain('skills:claude')
    expect(ids({ owl: id => id !== 'reply-quote' })).not.toContain('sotto.add-selection')
    expect(ids()).toContain('sotto.add-selection')
    expect(ids({ settings: { ...DEFAULT_SETTINGS, threadShortcuts: { 'stop-turn': null } } })).not.toContain('sotto.stop-turn')
    expect(ids({ settings: { ...DEFAULT_SETTINGS, nextPromptSuggestions: false } })).not.toContain('sotto.next-prompt')
    // ADR-0132 suggests nothing for Devin, a delegated thread or with local history off, so the tip would promise nothing.
    expect(ids()).toContain('sotto.next-prompt')
    expect(ids({ nextPrompts: false })).not.toContain('sotto.next-prompt')
    expect(ids({ settings: { ...DEFAULT_SETTINGS, dictationEnabled: false } })).not.toContain('sotto.dictate')
    expect(ids({ platform: 'linux' })).not.toContain('sotto.dictate')
    expect(ids({ skills: false })).not.toContain('skills:claude')
  })
})

describe('one tip per turn', () => {
  beforeEach(() => forgetShownTips())

  it('keeps a turn’s tip across renders and moves the next turn on to the next tip', () => {
    const store = createTipsSetAsideStore(memory())
    const candidates = tipCandidates(facts(), new Set())
    const first = chooseTip('t:1', 'thread:claude', candidates, new Set(), undefined, store)!
    expect(chooseTip('t:1', 'thread:claude', candidates, new Set(), undefined, store)!.id).toBe(first.id)
    expect(chooseTip('t:2', 'thread:claude', candidates, new Set(), undefined, store)!.id).toBe(candidates[1]!.id)
    expect(first.id).toBe(candidates[0]!.id)
    // Hidden mid-turn, the turn shows nothing more rather than a second tip.
    expect(chooseTip('t:2', 'thread:claude', candidates, new Set([candidates[1]!.id]), undefined, store)).toBeNull()
  })

  it('does not bring a turn’s tip back once it went, even when its target comes back', () => {
    const store = createTipsSetAsideStore(memory())
    const on = tipCandidates(facts({ skills: false }), new Set())
    const first = chooseTip('back:1', 'thread:claude', on, new Set(), undefined, store)!
    expect(chooseTip('back:1', 'thread:claude', on.filter(tip => tip.id !== first.id), new Set(), undefined, store)).toBeNull()
    expect(chooseTip('back:1', 'thread:claude', on, new Set(), undefined, store)).toBeNull()
  })

  it('keeps a named skill tip while its skill is still listed, when a refreshed list ranks another first', () => {
    const store = createTipsSetAsideStore(memory())
    const before = [skill('deploy', 'repo')]
    expect(chooseTip('rank:1', 'thread:claude', tipCandidates(facts({ catalog: before }), new Set()), new Set(), before, store)!.id).toBe('skill:claude:deploy')
    const after = [skill('audit', 'repo'), skill('deploy', 'user')]
    expect(tipCandidates(facts({ catalog: after }), new Set())[0]!.id).toBe('skill:claude:audit')
    expect(chooseTip('rank:1', 'thread:claude', tipCandidates(facts({ catalog: after }), new Set()), new Set(), after, store)).toMatchObject({ id: 'skill:claude:deploy', skill: { name: 'deploy' } })
  })

  it('keeps the turn’s tip when the skills list loads part-way through, until the user sets it aside', () => {
    const store = createTipsSetAsideStore(memory())
    const before = tipCandidates(facts(), new Set())
    expect(chooseTip('load:1', 'thread:claude', before, new Set(), undefined, store)!.id).toBe('skills:claude')
    const after = tipCandidates(facts({ catalog: [skill('deploy', 'repo')] }), new Set())
    expect(after.map(tip => tip.id)).not.toContain('skills:claude')
    expect(chooseTip('load:1', 'thread:claude', after, new Set(), undefined, store)!.id).toBe('skills:claude')
    expect(chooseTip('load:1', 'thread:claude', after, new Set(['skills:claude']), undefined, store)).toBeNull()
  })

  it('moves each audience and provider along its own rotation, so Watcher’s next turn never repeats for a thread’s', () => {
    expect(tipRotation({ audience: 'thread', providerId: 'claude' })).toBe('thread:claude')
    expect(tipRotation({ audience: 'thread', providerId: 'grok' })).toBe('thread:sotto')
    expect(tipRotation({ audience: 'watcher', providerId: 'claude' })).toBe('watcher:sotto')
    const store = createTipsSetAsideStore(memory())
    const watcher = tipCandidates(facts({ audience: 'watcher' }), new Set())
    const thread = tipCandidates(facts(), new Set())
    const first = chooseTip('w:1', 'watcher:sotto', watcher, new Set(), undefined, store)!
    chooseTip('t:9', 'thread:claude', thread, new Set(), undefined, store)
    chooseTip('t:10', 'thread:claude', thread, new Set(), undefined, store)
    expect(chooseTip('w:2', 'watcher:sotto', watcher, new Set(), undefined, store)!.id).not.toBe(first.id)
  })

  it('keeps a turn’s tip however many other turns come and go before it is read again', () => {
    const store = createTipsSetAsideStore(memory())
    const candidates = tipCandidates(facts(), new Set())
    const first = chooseTip('long:1', 'thread:claude', candidates, new Set(), undefined, store)!
    for (let turn = 0; turn < 2_000; turn++) chooseTip(`other:${turn}`, 'thread:claude', candidates, new Set(), undefined, store)
    expect(chooseTip('long:1', 'thread:claude', candidates, new Set(), undefined, store)!.id).toBe(first.id)
  })

  it('never lets a set-aside tip come back on its own, and writes one entry per press however many came before', () => {
    const storage = memory()
    const store = createTipsSetAsideStore(storage)
    for (let index = 0; index < 1_000; index++) store.setAside(`skill:claude:s${index}`)
    expect(store.ids().has('skill:claude:s0')).toBe(true)
    expect(store.ids().size).toBe(1_000)
    expect(storage.writes).toHaveLength(1_000)
    expect(storage.writes.at(-1)).toBe('sotto.tips.setAside.skill:claude:s999')
    expect(createTipsSetAsideStore(storage).ids().size).toBe(1_000)
    store.clear()
    expect(createTipsSetAsideStore(storage).ids().size).toBe(0)
  })

  it('shows no tip for the rest of a turn once what it points at stops being true', () => {
    const store = createTipsSetAsideStore(memory())
    const candidates = tipCandidates(facts({ skills: false }), new Set())
    const first = chooseTip('gone:1', 'thread:claude', candidates, new Set(), undefined, store)!
    expect(chooseTip('gone:1', 'thread:claude', candidates.filter(tip => tip.id !== first.id), new Set(), undefined, store)).toBeNull()
    // A named skill whose list failed to load again goes, rather than offering Try it with no limit to check.
    const named = tipCandidates(facts({ catalog: [skill('deploy', 'repo')] }), new Set())
    expect(chooseTip('gone:2', 'thread:claude', [named[0]!], new Set(), [skill('deploy', 'repo')], store)!.id).toBe('skill:claude:deploy')
    expect(chooseTip('gone:2', 'thread:claude', tipCandidates(facts({ catalog: undefined }), new Set()), new Set(), undefined, store)).toBeNull()
  })

  it('remembers hidden tips and the rotation in storage, and clears them on request', () => {
    const storage = memory()
    const store = createTipsSetAsideStore(storage)
    store.setAside('sotto.dictate')
    store.nextRotation('thread:claude')
    const again = createTipsSetAsideStore(storage)
    expect(again.ids().has('sotto.dictate')).toBe(true)
    expect(again.ids().size).toBe(1)
    expect(again.nextRotation('thread:claude')).toBe(1)
    expect(again.nextRotation('watcher:sotto'), 'each rotation keeps its own place').toBe(0)
    again.clear()
    expect(createTipsSetAsideStore(storage).ids().size).toBe(0)
  })
})

describe('the tip catalog points at things that exist', () => {
  it('gives every tip its own id', () => {
    expect(new Set(TIP_CATALOG.map(tip => tip.id)).size).toBe(TIP_CATALOG.length)
  })

  it('names only settings, shortcuts and Owl features Sotto has', () => {
    const features = new Set<string>(OWL_FEATURES.map(feature => feature.id))
    for (const tip of TIP_CATALOG) {
      if (tip.kind === 'setting') expect(Object.hasOwn(DEFAULT_SETTINGS, tip.setting), tip.id).toBe(true)
      if (tip.kind === 'shortcut') expect(THREAD_SHORTCUT_IDS, tip.id).toContain(tip.shortcut)
      if (tip.kind !== 'docs' && tip.feature !== undefined) expect(features.has(tip.feature), tip.id).toBe(true)
    }
  })

  it('records a page, a sentence and a checked date for every documentation tip, and a tip for every source', () => {
    const docs = TIP_CATALOG.filter(tip => tip.kind === 'docs').map(tip => tip.id).sort()
    expect(Object.keys(tipSources).sort()).toEqual(docs)
    for (const [id, source] of Object.entries(tipSources)) {
      expect(source.url, id).toMatch(/^https:\/\//u)
      expect(source.phrase.trim().length, id).toBeGreaterThan(10)
      expect(source.checked, id).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      expect(['claude', 'codex'], id).toContain(source.provider)
      expect(id.startsWith(`${source.provider}.`), id).toBe(true)
    }
  })
})

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const mountedEditors = new Set<PromptEditorElement['editor']>()
let sequence = 0
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', afterMessageId: `${THREAD}-1`, ...patch })

function stateWith(patch: Partial<AgentThread>, catalog?: AgentSkillCatalog): AgentState {
  const state = threadsStateFixture()
  state.activeThreadId = THREAD
  state.host.capabilities = { ...state.host.capabilities, skills: true }
  const thread = state.host.threads.find(item => item.id === THREAD)!
  Object.assign(thread, { providerId: 'claude', modelId: 'claude:sonnet', status: 'running', activities: [
    activity({ id: 'lifecycle-turn-1', kind: 'turn', title: 'Turn', status: 'running', startedAt: new Date(NOW - 5_000).toISOString() }),
  ] }, patch)
  if (catalog) state.skillCatalogs = [catalog]
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  for (const field of document.querySelectorAll<PromptEditorElement>('.prompt-editor')) mountedEditors.add(field.editor)
  return { live, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

describe('the tip under a working thread’s working line', () => {
  beforeEach(() => { owl.tips = true; sequence = 0; vi.mocked(useAgents).mockReset(); forgetShownTips(); tipsSetAside.clear(); localStorage.clear() })
  afterEach(() => {
    cleanup()
    for (const editor of mountedEditors) if (!editor.isDestroyed) editor.destroy()
    mountedEditors.clear()
    tipsSetAside.clear()
  })

  it('shows one tip under the words, and Hide sets it aside for good with focus back in the transcript', () => {
    const { transcript } = mount(stateWith({}))
    const line = within(transcript).getByTestId('thread-activity-live')
    const tip = within(line).getByRole('note', { name: 'Tip' })
    const id = tip.getAttribute('data-tip')!
    expect(id).toBe('skills:claude')
    expect(tip).toHaveTextContent('Type / in the prompt to pick one of this thread’s skills.')
    // Under the words, never announced.
    expect(tip.closest('[aria-live]:not([aria-live="off"]), [role="status"]')).toBeNull()
    fireEvent.click(within(tip).getByRole('button', { name: 'Hide this tip' }))
    expect(within(line).queryByRole('note', { name: 'Tip' })).toBeNull()
    expect(tipsSetAside.ids().has(id)).toBe(true)
    expect(document.activeElement).toBe(transcript)
  })

  it('puts a named skill in the prompt on Try it and never shows that tip again', () => {
    const catalog: AgentSkillCatalog = { threadId: THREAD, providerId: 'claude', cwd: 'x', status: 'ready', errors: [], maxSkillsPerMessage: 1, skills: [skill('deploy', 'repo', 'Ship it to staging.')] }
    const { transcript } = mount(stateWith({}, catalog))
    const tip = within(transcript).getByRole('note', { name: 'Tip' })
    expect(tip).toHaveTextContent('/deploy in the prompt: Ship it to staging.')
    fireEvent.click(within(tip).getByRole('button', { name: 'Put /deploy in the prompt' }))
    expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('/deploy ')
    expect(tipsSetAside.ids().has('skill:claude:deploy')).toBe(true)
    expect(within(transcript).queryByRole('note', { name: 'Tip' })).toBeNull()
  })

  it('offers no Try it while the prompt already carries as many skills as Claude takes', () => {
    const catalog: AgentSkillCatalog = { threadId: THREAD, providerId: 'claude', cwd: 'x', status: 'ready', errors: [], maxSkillsPerMessage: 1,
      skills: [skill('deploy', 'repo', 'Ship it to staging.'), skill('review', 'system', 'Review it.')] }
    const state = stateWith({}, catalog)
    state.threadDrafts = [{ threadId: THREAD, draftId: '7d1f6a2e-3c4b-4d5e-8f90-a1b2c3d4e5f6', text: '/review ', attachments: [],
      skills: [{ name: 'review', path: 'claude-command:x:review' }], files: [], requestId: null, updatedAt: new Date(NOW).toISOString() }]
    const { transcript } = mount(state)
    const tip = within(transcript).getByRole('note', { name: 'Tip' })
    expect(tip).toHaveAttribute('data-tip', 'skill:claude:deploy')
    expect(within(tip).queryByRole('button', { name: 'Put /deploy in the prompt' })).toBeNull()
    expect(within(tip).getByRole('button', { name: 'Hide this tip' })).toBeVisible()
  })

  it('shows nothing on stable, while the provider is away, or once the thread is not working', () => {
    owl.tips = false
    mount(stateWith({}))
    expect(screen.queryByRole('note', { name: 'Tip' })).toBeNull()
    cleanup()
    owl.tips = true
    mount(stateWith({ status: 'idle', activities: [] }))
    expect(screen.queryByRole('note', { name: 'Tip' })).toBeNull()
  })

  it('gives a thread on another provider a Sotto tip only', () => {
    mount(stateWith({ providerId: 'opencode', modelId: 'opencode:kimi' }))
    expect(screen.getByRole('note', { name: 'Tip' }).getAttribute('data-tip')).toMatch(/^sotto\./u)
  })
})

describe('Settings › Show tips while threads work', () => {
  it('saves the switch, counts hidden tips and shows them again', () => {
    const store = createTipsSetAsideStore(memory())
    store.setAside('sotto.dictate')
    store.setAside('skills:claude')
    const onSave = vi.fn()
    render(<ThreadTipsSetting checked onSave={onSave} store={store} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Show tips while threads work' }))
    expect(onSave).toHaveBeenCalledWith({ threadTips: false })
    expect(screen.getByText('2 tips hidden or used.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden tips again' }))
    expect(store.ids().size).toBe(0)
    expect(screen.getByText('No tips are hidden.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show hidden tips again' })).toBeDisabled()
    cleanup()
  })
})
