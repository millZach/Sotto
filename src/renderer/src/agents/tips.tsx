import React, { memo, useCallback, useMemo, type ReactNode } from 'react'
import { Lightbulb, X } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { AgentSkillReference } from '../../../shared/agentSkills'
import { capabilitiesForThread, type AgentState } from '../../../shared/agents'
import type { OwlFeatureId } from '../../../shared/owlFeatures'
import type { SottoPlatform } from '../../../shared/platform'
import type { AppSettings } from '../../../shared/settings'
import type { ThreadShortcutId } from '../../../shared/threadShortcuts'
import { ShortcutKey } from '../components/ShortcutKey'
import { useOptionalApp } from '../state/AppContext'
import { owlFeatureEnabledOf, useOwlFeature } from '../state/owlFeature'
import { insertSkill, pickableSkills, skillSigils, skillToken, type CatalogSkill } from './composerSkills'
import { withNextText } from './nextPrompts'
import type { ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { acceleratorForChord, claimedThreadChord, type ThreadShortcutSettings } from './threadShortcuts'
import { tipsSetAside, useTipsSetAside, type TipsSetAsideStore } from './tipsSetAside'
import TIP_SOURCES from './tipSources.json'

/**
 * Tips (ADR-0159): one short line under a working thread's working words, and Watcher's, about Sotto and the thread's
 * provider. A tip is only as current as what it points at, so each one is built from something Sotto can check:
 *
 * - a thread shortcut or a setting, which it names by id and reads the user's own keys from (a test holds every id);
 * - the thread's own skill catalog, when the user already loaded it, so a skill tip is about a skill that exists;
 * - a provider's documentation page, recorded in `tipSources.json` with the sentence the tip rests on and the day it was
 *   checked. A weekly job (`scripts/check-tip-sources.mjs`, `.github/workflows/tip-sources.yml`) reads each page and
 *   opens an issue when the sentence is gone, so the tip is rewritten or removed.
 *
 * Provider tips are Claude Code's and Codex's; every other provider gets Sotto's own tips only.
 */

export type TipAudience = 'thread' | 'watcher'

/** Everything a tip's choice reads. Built once per render of the working line, from state the transcript already holds. */
export interface TipFacts {
  readonly audience: TipAudience
  readonly providerId: string | undefined
  readonly platform: SottoPlatform
  readonly settings: (ThreadShortcutSettings & Pick<AppSettings, 'dictationEnabled' | 'nextPromptSuggestions'>) | null
  readonly owl: (id: OwlFeatureId) => boolean
  /** The thread's provider lists skills (its capabilities say so). */
  readonly skills: boolean
  /** The thread's skill catalog, when it is already loaded; a tip never asks the provider for it. */
  readonly catalog: readonly CatalogSkill[] | undefined
}

type TipSourceId = keyof typeof TIP_SOURCES
interface TipSource { readonly provider: string; readonly url: string; readonly phrase: string; readonly checked: string }
export const tipSources: Readonly<Record<TipSourceId, TipSource>> = TIP_SOURCES

/** The providers whose own commands, skills and documentation get tips (Zach, October 28, 2026). */
const PROVIDER_TIPS: ReadonlySet<string> = new Set(['claude', 'codex'])

interface ShortcutTip {
  readonly kind: 'shortcut'; readonly id: string; readonly shortcut: ThreadShortcutId; readonly audience: readonly TipAudience[]
  readonly feature?: OwlFeatureId; readonly Text: (props: { readonly keys: ReactNode }) => ReactNode
}
interface SettingTip {
  readonly kind: 'setting'; readonly id: string; readonly setting: keyof AppSettings; readonly audience: readonly TipAudience[]
  readonly feature?: OwlFeatureId; readonly shows: (facts: TipFacts) => boolean; readonly Text: (props: { readonly facts: TipFacts }) => ReactNode
}
interface FeatureTip {
  readonly kind: 'feature'; readonly id: string; readonly feature: OwlFeatureId; readonly audience: readonly TipAudience[]
  /** What Try it puts in the prompt. */
  readonly insert?: MessageDescriptor; readonly Text: () => ReactNode
}
interface DocsTip { readonly kind: 'docs'; readonly id: TipSourceId; readonly Text: () => ReactNode }
export type CatalogTip = ShortcutTip | SettingTip | FeatureTip | DocsTip

/** Sotto's own tips and the provider documentation tips. Order is the rotation's order. */
export const TIP_CATALOG: readonly CatalogTip[] = [
  { kind: 'shortcut', id: 'sotto.next-waiting', shortcut: 'next-waiting', audience: ['thread'],
    Text: ({ keys }) => <Trans comment="A tip under a working thread. {keys} is a keyboard shortcut.">Press {keys} to jump to the next thread waiting on you.</Trans> },
  { kind: 'docs', id: 'claude.claude-md',
    Text: () => <Trans comment="A tip under a working Claude thread.">Claude reads <code>CLAUDE.md</code> at the start of every session. Ask it to add a rule there instead of repeating yourself.</Trans> },
  { kind: 'docs', id: 'codex.agents-md',
    Text: () => <Trans comment="A tip under a working Codex thread.">Codex reads <code>AGENTS.md</code> before it does any work. Ask it to add a rule there instead of repeating yourself.</Trans> },
  { kind: 'setting', id: 'sotto.dictate', setting: 'hotkey', audience: ['thread', 'watcher'],
    // Linux dictation listens through the desktop's own binding, not this accelerator.
    shows: facts => facts.platform !== 'linux' && facts.settings?.dictationEnabled !== false,
    Text: ({ facts }) => {
      const keys = <ShortcutKey accelerator={facts.settings?.hotkey ?? ''} platform={facts.platform} />
      return <Trans comment="A tip under a working thread. {keys} is the dictation shortcut.">Press {keys} to dictate your next prompt instead of typing it.</Trans>
    } },
  { kind: 'feature', id: 'watcher.waiting', feature: 'watcher', audience: ['watcher'],
    insert: msg({ message: 'Which threads are waiting on me?', comment: 'Put in Watcher\'s prompt by a tip\'s Try it.' }),
    Text: () => <Trans comment="A tip under Watcher's working line.">Ask Watcher which threads are waiting on you.</Trans> },
  { kind: 'shortcut', id: 'sotto.stop-turn', shortcut: 'stop-turn', audience: ['thread'],
    Text: ({ keys }) => <Trans comment="A tip under a working thread. {keys} is a keyboard shortcut.">Press {keys} to stop this turn.</Trans> },
  { kind: 'docs', id: 'claude.subagents',
    Text: () => <Trans comment="A tip under a working Claude thread.">For a wide search, ask Claude to use subagents. Each runs in its own context, so this thread’s stays small.</Trans> },
  { kind: 'docs', id: 'codex.skills-folder',
    Text: () => <Trans comment="A tip under a working Codex thread.">A skill in the project’s <code>.agents/skills</code> folder is one <code>$</code> away in every Codex thread there.</Trans> },
  { kind: 'setting', id: 'sotto.web-links', setting: 'webLinkDestination', audience: ['thread', 'watcher'], shows: () => true,
    Text: () => <Trans comment="A tip under a working thread.">Right-click a link in a reply, or press <kbd>Shift+F10</kbd> on it, to choose where it opens.</Trans> },
  { kind: 'feature', id: 'watcher.start-thread', feature: 'watcher', audience: ['watcher'],
    Text: () => <Trans comment="A tip under Watcher's working line.">Ask Watcher to start a thread for a job. It follows the thread and tells you when it needs you.</Trans> },
  { kind: 'shortcut', id: 'sotto.add-selection', shortcut: 'add-selection', audience: ['thread'], feature: 'reply-quote',
    Text: ({ keys }) => <Trans comment="A tip under a working thread. {keys} is a keyboard shortcut.">Select words in a reply and press {keys} to quote them in your prompt.</Trans> },
  { kind: 'setting', id: 'sotto.next-prompt', setting: 'nextPromptSuggestions', audience: ['thread'], feature: 'next-prompt',
    shows: facts => facts.settings?.nextPromptSuggestions === true,
    Text: () => <Trans comment="A tip under a working thread.">When this turn ends, press <kbd>Tab</kbd> in an empty prompt to use the suggested next prompt.</Trans> },
  { kind: 'shortcut', id: 'sotto.terminal-drawer', shortcut: 'terminal-drawer', audience: ['thread'],
    Text: ({ keys }) => <Trans comment="A tip under a working thread. {keys} is a keyboard shortcut.">Press {keys} to show this thread’s terminal drawer.</Trans> },
  { kind: 'shortcut', id: 'sotto.focus-prompt', shortcut: 'focus-prompt', audience: ['thread'],
    Text: ({ keys }) => <Trans comment="A tip under a working thread. {keys} is a keyboard shortcut.">Press {keys} to put the cursor in the prompt.</Trans> },
]

/** One tip ready to draw: its id, what it says, and what Try it does, if anything. */
export interface TipChoice {
  readonly id: string
  readonly text: ReactNode
  readonly skill?: CatalogSkill & AgentSkillReference
  readonly insert?: MessageDescriptor
}

/** A skill's own description, cut to its first sentence so the line stays one thought. */
function shortDescription(description: string): string {
  const flat = description.replace(/\s*\((?:user|project|plugin[^)]*)\)\s*$/iu, '').replace(/\s+/gu, ' ').trim()
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(flat)?.[0] ?? flat
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence
}

const SCOPE_ORDER: Readonly<Record<string, number>> = { repo: 0, user: 1, admin: 2, system: 3 }

/** The skill the next skill tip names: the user's and the project's own first, as the ones a reader is likeliest to have forgotten. */
function skillTip(facts: TipFacts, setAside: ReadonlySet<string>): TipChoice | null {
  const provider = facts.providerId ?? ''
  const skills = pickableSkills(facts.catalog ?? []).filter(skill => skill.description.trim() !== '' && !setAside.has(`skill:${provider}:${skill.name}`))
  const skill = [...skills].sort((a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9))[0]
  if (!skill) return null
  const token = <code>{skillToken(skill)}</code>, about = shortDescription(skill.description)
  return { id: `skill:${provider}:${skill.name}`, skill,
    text: <Trans comment="A tip naming one of the thread's skills. {token} is how it is written in the prompt; {about} is the provider's own description of it.">{token} in the prompt: {about}</Trans> }
}

/**
 * The tips this working line could show, in the rotation's order, less the ones the user hid or used. Provider tips
 * only reach a Claude or Codex thread; Watcher's line gets Sotto's and Watcher's own.
 */
export function tipCandidates(facts: TipFacts, setAside: ReadonlySet<string>): TipChoice[] {
  const provider = facts.audience === 'thread' && facts.providerId !== undefined && PROVIDER_TIPS.has(facts.providerId) ? facts.providerId : null
  const out: TipChoice[] = []
  if (provider !== null && facts.skills) {
    const named = skillTip(facts, setAside)
    if (named) out.push(named)
    else if (facts.catalog === undefined && !setAside.has(`skills:${provider}`)) {
      // Claude reads `/` at the start of a line and Codex `$` anywhere; the picker opens on either.
      const sigil = <code>{provider === 'codex' ? '$' : '/'}</code>
      out.push({ id: `skills:${provider}`, text: <Trans comment="A tip under a working thread. {sigil} is the character that opens the skills list.">Type {sigil} in the prompt to pick one of this thread’s skills.</Trans> })
    }
  }
  for (const tip of TIP_CATALOG) {
    if (setAside.has(tip.id)) continue
    if (tip.kind === 'docs') {
      const source = tipSources[tip.id]
      if (source.provider === provider) out.push({ id: tip.id, text: <tip.Text /> })
      continue
    }
    if (!tip.audience.includes(facts.audience) || (tip.feature !== undefined && !facts.owl(tip.feature))) continue
    if (tip.kind === 'shortcut') {
      const chord = claimedThreadChord(facts.settings, tip.shortcut, facts.platform)
      if (chord !== null) out.push({ id: tip.id, text: <tip.Text keys={<ShortcutKey accelerator={acceleratorForChord(chord, facts.platform)} platform={facts.platform} />} /> })
    } else if (tip.kind === 'setting') {
      if (tip.shows(facts)) out.push({ id: tip.id, text: <tip.Text facts={facts} /> })
    } else {
      out.push({ id: tip.id, text: <tip.Text />, ...(tip.insert ? { insert: tip.insert } : {}) })
    }
  }
  return out
}

/** Which tip each turn showed, so a turn keeps its tip across renders and the next turn moves on (Zach's pick: one per turn). */
const shownByTurn = new Map<string, string>()
const SHOWN_LIMIT = 64

export function chooseTip(turnKey: string, candidates: readonly TipChoice[], store: TipsSetAsideStore = tipsSetAside): TipChoice | null {
  const shown = shownByTurn.get(turnKey)
  if (shown !== undefined) return candidates.find(tip => tip.id === shown) ?? null
  if (!candidates.length) return null
  const tip = candidates[store.nextRotation() % candidates.length]!
  shownByTurn.set(turnKey, tip.id)
  if (shownByTurn.size > SHOWN_LIMIT) shownByTurn.delete(shownByTurn.keys().next().value!)
  return tip
}

/** For tests: forget which tip each turn showed. */
export function forgetShownTips(): void { shownByTurn.clear() }

/**
 * The tip line under the working words (Zach's pick, variant B of docs/prototypes/thread-tips-prototype.html with a
 * lightbulb for the word "Tip"): hooked to the words, muted, a size down. Try it puts the tip's command or question in
 * the prompt and counts as using the tip; Hide sets it aside. Either way it never shows again. It is not a live region:
 * a tip is there to be read when the reader looks, never announced.
 */
export const ThreadTip = memo(function ThreadTip({ turnKey, facts, onTry, store = tipsSetAside }: {
  /** The thread and its running turn: a turn keeps one tip. */
  readonly turnKey: string
  readonly facts: TipFacts
  /** Try it: put the skill or the words in this thread's prompt and move focus there. */
  readonly onTry: (tip: TipChoice, insert: string | undefined) => void
  readonly store?: TipsSetAsideStore
}): ReactNode {
  const { t, i18n } = useLingui()
  const setAside = useTipsSetAside(store)
  const candidates = useMemo(() => tipCandidates(facts, setAside), [facts, setAside])
  const tip = chooseTip(turnKey, candidates, store)
  if (tip === null) return null
  const insert = tip.insert ? i18n._(tip.insert) : undefined
  const tryName = tip.skill ? t({ message: `Put ${skillToken(tip.skill)} in the prompt`, comment: 'A tip\'s Try it button, named for what it does. {0} is a skill as written in the prompt.' })
    : insert !== undefined ? t({ message: `Put “${insert}” in the prompt`, comment: 'A tip\'s Try it button, named for what it does.' }) : null
  const hide = t({ message: 'Hide this tip', comment: 'The button on a tip that hides it for good.' })
  // The hidden tip's buttons leave with it, so focus goes back to the working line, or to the transcript holding it.
  const hideTip = (pressed: HTMLElement): void => {
    const line = pressed.closest('.thread-activity-live')
    const next = line?.querySelector<HTMLElement>('button.thread-activity-live__line') ?? line?.closest<HTMLElement>('[role="log"]')
    store.setAside(tip.id)
    next?.focus()
  }
  return <div className="thread-tip" role="note" aria-label={t({ message: 'Tip', comment: 'What a screen reader calls the tip line under the working words.' })} data-tip={tip.id}>
    <span className="thread-tip__hook" aria-hidden="true" />
    <Lightbulb className="thread-tip__bulb" size={14} strokeWidth={1.9} aria-hidden="true" />
    <span className="thread-tip__text">{tip.text}
      <span className="thread-tip__actions">
        {tryName !== null ? <button type="button" className="thread-tip__try tt-focusable" aria-label={tryName}
          onClick={() => { store.setAside(tip.id); onTry(tip, insert) }}><Trans comment="A tip's button that puts what it names in the prompt.">Try it</Trans></button> : null}
        <button type="button" className="thread-tip__hide tt-focusable" aria-label={hide} title={hide} onClick={event => hideTip(event.currentTarget)}>
          <X size={14} aria-hidden="true" />
        </button>
      </span>
    </span>
  </div>
})

/**
 * The tip a thread's working line shows, or undefined when tips are off: held to Owl (ADR-0072) and to Settings ›
 * Threads › Show tips while threads work. Reads only state the transcript already has; a tip never loads a catalog.
 */
export function useTipLine({ row, state, store, watcher, onFocusPrompt }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly store: ThreadDraftStore
  readonly watcher: boolean
  /** Moves focus to this thread's prompt after Try it. */
  readonly onFocusPrompt?: (() => void) | undefined
}): ((turnId: string) => ReactNode) | undefined {
  const on = useOwlFeature('thread-tips')
  const app = useOptionalApp()
  const settings = app?.settings ?? null
  const platform = app?.platform ?? 'win32'
  const update = app?.update
  const thread = row.thread
  const providerId = row.providerId
  const skills = on && !watcher && capabilitiesForThread(state.host, thread).skills === true
  const catalog = on && skills ? state.skillCatalogs?.find(item => item.threadId === thread.id) : undefined
  const ready = catalog?.status === 'ready' ? catalog.skills : undefined
  const facts = useMemo<TipFacts>(() => ({
    audience: watcher ? 'watcher' : 'thread', providerId, platform, settings, skills, catalog: ready,
    owl: id => owlFeatureEnabledOf(update, id),
  }), [watcher, providerId, platform, settings, skills, ready, update])
  const threadId = thread.id
  const onTry = useCallback((tip: TipChoice, insert: string | undefined): void => {
    const draft = store.draft(threadId)
    if (tip.skill) {
      // The skill goes on a line of its own after anything already written, where both `/` and `$` are read.
      const base = draft.text.trim() === '' ? '' : `${draft.text.replace(/\s+$/u, '')}\n`
      const next = insertSkill(base, { kind: 'slash', query: '', start: base.length, end: base.length }, tip.skill, draft.skills, skillSigils(providerId))
      store.edit(threadId, { text: next.text, skills: next.skills })
    } else if (insert !== undefined) store.edit(threadId, { text: withNextText(draft.text, insert) })
    onFocusPrompt?.()
  }, [store, threadId, providerId, onFocusPrompt])
  return useMemo(() => !on || settings?.threadTips === false ? undefined
    : (turnId: string) => <ThreadTip turnKey={`${threadId}:${turnId}`} facts={facts} onTry={onTry} />, [on, settings?.threadTips, threadId, facts, onTry])
}
