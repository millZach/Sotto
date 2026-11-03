import React, { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentModel } from '../../../shared/agents'
import { useAnchoredMenu } from './anchoredMenu'
import { moveListboxFocus } from './listboxKeys'
import { countModels, LegacyRow, lineupModels, matchesWords, modelSources, newestModelsFirst, searchWords, useLegacyName } from './ModelPicker'
import './modelPicker.css'

/**
 * A provider's models on the Providers page: a small field naming how many there are, which opens a searchable list
 * anchored over it the way the composer's model menu opens, so one provider's models never fill the page. It is a list
 * to look through, not a choice: what new threads start with is chosen in Settings › Threads, and its model is marked here
 * as the Agent setting. A provider whose models name their source (OpenCode's model sources, Cursor's model makers) lists them
 * under each source. Claude Code's and Codex's list the newest model of each line, and the older ones under a closed Legacy
 * row that a search also looks through (ADR-0171). Escape clears the search, then closes the list.
 */
export function ProviderModelList({ label, models, agentEntryId }: {
  /** The provider's name, as the page shows it. */
  readonly label: string
  /** The models the provider offers now; the page passes only the ones that can be used. */
  readonly models: readonly AgentModel[]
  /** The catalog entry new threads on this computer start with, marked in the list. */
  readonly agentEntryId?: string | undefined
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [legacyOpen, setLegacyOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dialogId = useId()
  useAnchoredMenu(open, trigger, dialog, search)
  const words = searchWords(query)
  // Each word matches on its own, against the model's name, its ID and its source, as the composer's menu searches.
  const matches = (model: AgentModel): boolean => matchesWords(`${model.name} ${model.id} ${model.source ?? ''}`, words)
  const sources = open ? modelSources(models, label) : undefined
  const lineup = open && !sources ? lineupModels(models, () => false) : undefined
  const groups = !open ? [] : sources
    ? sources.map(source => ({ name: source.name, models: source.models.filter(matches) })).filter(source => source.models.length)
    : [{ name: '', models: (lineup?.latest ?? newestModelsFirst(models)).filter(matches) }].filter(group => group.models.length)
  const legacy = lineup?.legacy.filter(matches) ?? []
  const legacyName = useLegacyName()
  const count = countModels(models.length)
  const close = (): void => setOpen(false)
  const row = (model: AgentModel): ReactNode => <li key={model.id} tabIndex={-1}>
    <span><b>{model.name}</b>{model.reasoningEfforts?.length ? <small>{model.reasoningEfforts.join(' · ')}</small> : null}</span>
    {model.id === agentEntryId ? <span className="provider-model-list__tag">{t`Agent setting`}</span> : null}
  </li>
  return <div className="provider-model-list">
    <button ref={trigger} type="button" className="provider-model-list__trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      aria-label={plural(models.length, { one: `Show ${label} models, # model`, other: `Show ${label} models, # models` })}
      onClick={() => { setQuery(''); setLegacyOpen(false); setOpen(true) }}>
      <span>{count}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <dialog ref={dialog} id={dialogId} className="model-picker__dialog provider-model-list__dialog" aria-label={t({ message: `${label} models`, comment: '{label} is a provider\'s name.' })}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !query) return
        event.preventDefault(); event.stopPropagation(); setQuery(''); search.current?.focus()
      }}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}
      onClick={event => { if (event.target === event.currentTarget) close(); event.stopPropagation() }}>
      <div className="model-picker__panel">
        <header className="model-picker__search"><Search size={15} aria-hidden="true" />
          <input ref={search} aria-label={t`Search models`} placeholder={t({ message: `Search ${label} models`, comment: '{label} is a provider\'s name.' })} value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') event.preventDefault()
              if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLElement>('li')?.focus() }
            }} />
          <button type="button" aria-label={t`Close models`} title={t`Close models`} onClick={close}><X size={15} aria-hidden="true" /></button>
        </header>
        {/* One tab stop: the arrows move through the rows as the model menu's do, though the rows are to read, not to
            choose, and Up from the first goes back to search. */}
        <div ref={list} role="region" tabIndex={0} onKeyDown={event => moveListboxFocus(event, list.current, search.current, 'li, .model-picker__legacy')} aria-label={t({ message: `${label} models`, comment: '{label} is a provider\'s name.' })} className="model-picker__models provider-model-list__models">
          {groups.map(group => group.name
            ? <section key={group.name} aria-label={group.name}><p className="model-picker__group" aria-hidden="true">{group.name}<span>{group.models.length}</span></p><ul>{group.models.map(row)}</ul></section>
            : <ul key="models">{group.models.map(row)}</ul>)}
          {legacy.length > 0 ? <section aria-label={legacyName}>
            {words.length ? <p className="model-picker__group" aria-hidden="true">{legacyName}<span>{legacy.length}</span></p>
              : <LegacyRow open={legacyOpen} count={legacy.length} onToggle={() => setLegacyOpen(shown => !shown)} />}
            {words.length || legacyOpen ? <ul>{legacy.map(row)}</ul> : null}
          </section> : null}
          {!groups.length && !legacy.length && <p className="model-picker__empty tt-paragraph">{t`No matching models.`}</p>}
        </div>
        <p className="model-picker__note tt-paragraph">{t`Choose what new threads start with in Settings > Threads.`}</p>
      </div>
    </dialog>}
  </div>
}
