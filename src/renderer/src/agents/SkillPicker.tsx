import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import type { AgentSkillCatalog, AgentSkillReference } from '../../../shared/agentSkills'
import type { AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import {
  detectSkillTrigger, pickableSkills, searchSkills, skillLimitReached, skillScopeLabel, skillToken, type CatalogSkill, type SkillTrigger,
} from './composerSkills'

type Command = AgentConnection['command']

export interface SkillPickerModel {
  readonly open: boolean
  readonly trigger: SkillTrigger | null
  readonly options: readonly CatalogSkill[]
  /** Null until the user moves through a `/` list: Enter then sends the typed text unchanged. */
  readonly activeIndex: number | null
  readonly catalog: AgentSkillCatalog | undefined
  readonly loading: boolean
  readonly requestError: string | null
  readonly move: (offset: 1 | -1) => void
  readonly highlight: (index: number) => void
  readonly close: () => void
  readonly refresh: (forceReload: boolean) => void
  /** The caret or selection moved in the textarea. */
  readonly track: (element: HTMLTextAreaElement) => void
  /** Focus left the composer's text and the picker. */
  readonly leave: () => void
}

/**
 * The picker's state for one thread's composer. Opening a trigger asks main for the thread's native
 * catalog (cached unless it changed); Refresh asks for a reload. Nothing here edits the draft.
 */
export function useSkillPicker({ threadId, state, command, enabled, text }: {
  readonly threadId: string; readonly state: AgentState; readonly command: Command; readonly enabled: boolean; readonly text: string
}): SkillPickerModel {
  const catalog = state.skillCatalogs?.find(item => item.threadId === threadId)
  const load = useCallback((forceReload: boolean): Promise<boolean> =>
    command({ type: 'refresh-thread-skills', threadId, ...(forceReload ? { forceReload: true } : {}) }).then(result => result !== null), [command, threadId])
  return useCatalogSkillPicker({ ownerId: threadId, catalog, load, enabled, text })
}

/**
 * The same picker over any owner's catalog: a thread's from the agent state, or a personal chat's read from its bridge.
 * `load` asks for the catalog (a reload when forced) and resolves false when the request itself failed.
 */
export function useCatalogSkillPicker({ ownerId, catalog, load, enabled, text }: {
  readonly ownerId: string; readonly catalog: AgentSkillCatalog | undefined; readonly load: (forceReload: boolean) => Promise<boolean>
  readonly enabled: boolean; readonly text: string
}): SkillPickerModel {
  const [selection, setSelection] = useState<{ readonly start: number; readonly end: number } | null>(null)
  const [active, setActive] = useState<{ readonly key: string; readonly index: number } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const requested = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const trigger = enabled && selection !== null ? detectSkillTrigger(text, selection.start, selection.end) : null
  const openKey = trigger === null ? null : `${ownerId}\n${trigger.kind}\n${trigger.start}`
  const open = trigger !== null && dismissed !== openKey
  const options = open && catalog?.status === 'ready' ? searchSkills(pickableSkills(catalog.skills), trigger.query) : []
  const queryKey = open ? `${openKey}\n${trigger.query}` : null
  const chosen = active !== null && active.key === queryKey ? active.index : null
  const activeIndex = options.length === 0 ? null : chosen !== null ? Math.min(chosen, options.length - 1) : trigger?.kind === 'dollar' ? 0 : null

  const refresh = useCallback((forceReload: boolean): void => {
    setLoading(true)
    setRequestError(null)
    void load(forceReload).then(ok => {
      if (!mounted.current) return
      setLoading(false)
      if (!ok) setRequestError('Sotto couldn’t load skills.')
    }, () => { if (mounted.current) { setLoading(false); setRequestError('Sotto couldn’t load skills.') } })
  }, [load])

  useEffect(() => {
    if (!open || openKey === null || requested.current === openKey) return
    requested.current = openKey
    refresh(false)
  }, [open, openKey, refresh])
  const noTrigger = trigger === null
  useEffect(() => { if (noTrigger) { requested.current = null; if (dismissed !== null) setDismissed(null) } }, [noTrigger, dismissed])

  return {
    open, trigger: open ? trigger : null, options, activeIndex, catalog, loading, requestError, refresh,
    move: offset => {
      if (queryKey === null || options.length === 0) return
      const from = activeIndex ?? (offset === 1 ? -1 : options.length)
      setActive({ key: queryKey, index: (from + offset + options.length) % options.length })
    },
    highlight: index => { if (queryKey !== null) setActive({ key: queryKey, index }) },
    close: () => { if (openKey !== null) setDismissed(openKey) },
    leave: () => setSelection(null),
    track: element => {
      const next = { start: element.selectionStart, end: element.selectionEnd }
      setSelection(current => current?.start === next.start && current.end === next.end ? current : next)
    },
  }
}

export const skillOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

/** The skills list above the composer's text. It shows the native catalog exactly; it never manages skills. */
export function SkillPicker({ model, listId, provider, selected = [], emptyMessage = 'No skills are available in this thread’s folder.', onSelect }: {
  readonly model: SkillPickerModel
  readonly listId: string
  readonly provider: string
  /** Skills already chosen in this draft, for a provider's per-message limit. */
  readonly selected?: readonly AgentSkillReference[]
  /** What an empty catalog means where this composer lives. */
  readonly emptyMessage?: string
  readonly onSelect: (skill: CatalogSkill) => void
}): ReactNode {
  const list = useRef<HTMLUListElement>(null)
  const { trigger, options, activeIndex, catalog, loading, requestError } = model
  useLayoutEffect(() => {
    if (activeIndex === null) return
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(skillOptionId(listId, activeIndex))}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listId])
  if (!model.open || trigger === null) return null
  const failure = requestError ?? (catalog?.status === 'error' ? catalog.error ?? `${provider} couldn’t list skills for this folder.` : null)
  const unsupported = failure === null && catalog?.status === 'unsupported'
  const limit = catalog?.maxSkillsPerMessage
  const message = failure !== null ? failure
    : unsupported ? catalog.error ?? `${provider} doesn’t list skills here.`
      : catalog === undefined ? (loading ? 'Loading skills…' : 'Skills aren’t loaded yet.')
        : catalog.skills.length === 0 ? emptyMessage
          : pickableSkills(catalog.skills).length === 0 ? `None of ${provider}’s skills here can be chosen from a message.`
            : options.length === 0 ? `No skills match “${trigger.query}”.` : null
  const skipped = catalog?.status === 'ready' ? catalog.errors.length : 0
  const held = selected.at(-1)
  const heldSkill = held === undefined ? undefined : catalog?.skills.find(skill => skill.name === held.name && skill.path === held.path) ?? held
  const limitNote = limit !== undefined && held !== undefined && options.some(skill => skillLimitReached(selected, skill, limit))
    ? `${provider} takes ${limit === 1 ? 'one skill' : `${limit} skills`} per message. Remove ${skillToken(heldSkill!)} to choose another.` : null
  const hint = options.length === 0 ? (trigger.kind === 'slash' || unsupported ? 'Enter sends what you typed.' : null)
    : trigger.kind === 'slash' && activeIndex === null ? '↓ to choose · Enter sends what you typed' : 'Enter or Tab inserts the skill'
  // The list gets the height; what Sotto has to say about it and the one reload action share a line under it.
  return <div className="skill-picker" data-kind={trigger.kind}>
    {message === null ? <ul ref={list} className="skill-picker__list" role="listbox" id={listId} aria-label="Skills">
      {options.map((skill, index) => {
        const over = skillLimitReached(selected, skill, limit)
        return <li key={`${skill.path}\n${skill.name}\n${index}`} id={skillOptionId(listId, index)} role="option" aria-selected={index === activeIndex} aria-disabled={over || undefined}
          className="skill-picker__option" data-active={index === activeIndex || undefined}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== activeIndex) model.highlight(index) }} onClick={() => { if (!over) onSelect(skill) }}>
          <span className="skill-picker__name">{skillToken(skill)}</span>
          <span className="skill-picker__description">{skill.description}</span>
          <span className="skill-picker__scope">{skillScopeLabel(skill.scope)}</span>
        </li>
      })}
    </ul> : null}
    <div className="skill-picker__foot" data-message={message !== null || undefined}>
      <span className="skill-picker__notes">
        {message !== null ? <span className="skill-picker__message" role={failure !== null ? 'alert' : 'status'} data-tone={failure !== null ? 'warning' : undefined}>{message}</span> : null}
        {limitNote !== null ? <span className="skill-picker__limit" role="status">{limitNote}</span> : hint !== null ? <span>{hint}</span> : null}
        {catalog?.invocationNotice && catalog.status !== 'error' ? <span>{catalog.invocationNotice}</span> : null}
        {skipped > 0 ? <span data-tone="warning">{skipped === 1 ? '1 skill file couldn’t be read' : `${skipped} skill files couldn’t be read`}</span> : null}
      </span>
      <button type="button" className="skill-picker__refresh tt-focusable" data-loading={loading || undefined} disabled={loading}
        onMouseDown={event => event.preventDefault()} onClick={() => model.refresh(true)}>
        <RotateCw size={14} aria-hidden="true" />{loading ? 'Refreshing' : failure !== null ? 'Try again' : 'Refresh'}
      </button>
    </div>
  </div>
}
