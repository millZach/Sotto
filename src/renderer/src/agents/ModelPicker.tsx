import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { OPENCODE_ZEN_SOURCE, type AgentModel, type ProviderId } from '../../../shared/agents'
import type { OwnServersBridge } from '../../../shared/ownModelServers'
import { catalogEntry, resolveModel } from '../../../shared/modelCatalog'
import { moveListboxFocus } from './listboxKeys'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { ProviderMark } from './ProviderMark'
import { AddOwnServerDialog, OwnServerMenuEntry } from './OwnModelServers'
import './threadChips.css'
import './modelPicker.css'

/** How far a touchpad moves, in pixels, to step the provider rail once; a mouse notch is more than this. */
const RAIL_WHEEL_STEP = 40
/** The quiet, in milliseconds, that ends one turn of the wheel: a swipe and its momentum are one turn. */
const RAIL_WHEEL_PAUSE = 150

/** One turn of the wheel over the provider rail: when it last moved, which way, how far, and whether it has stepped. */
interface RailWheelTurn { at: number; direction: number; travel: number; stepped: boolean }
const restingWheel = (): RailWheelTurn => ({ at: -Infinity, direction: 0, travel: 0, stepped: false })

/**
 * Newest first, with the model the provider itself recommends kept at the top whatever it is called. The
 * recommendation is the provider's own answer to the question the list is asking, so it does not compete on
 * version number: "Default (recommended)" carries no version and would otherwise sort below everything.
 */
export function newestModelsFirst(models: readonly AgentModel[]): AgentModel[] {
  const version = (model: AgentModel): number[] => (model.name.match(/\d+(?:\.\d+)*/)?.[0] ?? model.id.match(/\d+(?:\.\d+)*/)?.[0] ?? '').split('.').map(Number)
  return [...models].sort((left, right) => {
    if (Boolean(left.recommended) !== Boolean(right.recommended)) return left.recommended ? -1 : 1
    const leftVersion = version(left)
    const rightVersion = version(right)
    for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
      const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0)
      if (difference) return difference
    }
    return 0
  })
}

/** Models under the name `by` gives each, in the order each name first appears and each group in the order given. */
function groupModels(models: readonly AgentModel[], by: (model: AgentModel) => string): Map<string, AgentModel[]> {
  const result = new Map<string, AgentModel[]>()
  for (const model of models) {
    const name = by(model)
    const group = result.get(name)
    if (group) group.push(model)
    else result.set(name, [model])
  }
  return result
}

/** One model source of a provider that offers models from several (ADR-0087), with its models newest first. */
export interface ModelSourceGroup { readonly name: string; readonly models: AgentModel[] }

/**
 * A provider's models by model source, or undefined for a provider whose models name none, whose menu stays one list.
 * OpenCode Zen comes first, since every OpenCode folder has it, then the rest in the order the provider lists them. A
 * model without a source among ones that have one goes under the provider's own name.
 */
export function modelSources(models: readonly AgentModel[], provider: string): ModelSourceGroup[] | undefined {
  if (!models.some(model => model.source !== undefined)) return undefined
  return [...groupModels(models, model => model.source ?? provider)].map(([name, items]) => ({ name, models: newestModelsFirst(items) }))
    .sort((left, right) => Number(right.name === OPENCODE_ZEN_SOURCE) - Number(left.name === OPENCODE_ZEN_SOURCE))
}

/** A model source name longer than this many characters may give way on the chip, down to a floor; a shorter one never does. */
const LONG_SOURCE = 9

const countModels = (count: number): string => `${count} model${count === 1 ? '' : 's'}`

/** A provider the menu lists without models, and why: one the user turned on that cannot take the choice now. */
export interface UnavailablePickerProvider { readonly name: string; readonly providerId?: ProviderId | undefined; readonly reason: string }
/**
 * Providers whose models start a new thread rather than change this one (ADR-0089): the heading over their models and
 * the note under them, in place of the menu's own.
 */
export interface PickerContinuation { readonly providers: ReadonlySet<string>; readonly heading: (provider: string) => string; readonly note: string }

/**
 * The model control: a chip carrying the provider's mark and the model's name, which opens a compact menu
 * anchored over it. The menu is two columns. On the left a rail of provider marks, one tile each and no
 * names, so the menu costs the same whatever a provider is called; the name is the tile's accessible name
 * and its tooltip. On the right the chosen provider's models under a search line, with `note` beneath them
 * -- the reminder that a new thread may still change provider, or that this one may not. The wheel over the
 * rail steps through the providers as its arrow keys do. A single provider has no rail. Escape, a click
 * outside or a choice closes the menu and returns focus to the chip; a choice shows on the chip at once while
 * the owner saves it. A provider in `unavailable` has a tile whose panel says why it cannot be chosen now; one in
 * `continueOn` heads its models with where they start.
 *
 * A provider whose models name their model source (OpenCode, ADR-0087) opens on its sources instead: each with its
 * model count, the one holding the chosen model in the accent colour. Choosing one shows its models under a back
 * control; typing searches every source at once, under small source headings. Escape steps back one level at a time:
 * it clears the search, then leaves the source with focus on its row, then closes the menu. The chip names the source
 * before the model, and the source gives way first in a narrow composer. With `ownServers`, OpenCode's source list ends
 * with Your own server…, which closes the menu and opens the Add a server dialog (ADR-0124); closing that hands focus
 * back to the chip.
 */
export function ModelPicker({ models, modelId, disabled, onChange, note, unavailable = [], continueOn, label = OPTION_CHIP_NAMES.model, openOnMount = false, pending = false, describedBy, ownServers }: {
  readonly models: AgentModel[]; readonly modelId: string; readonly disabled: boolean; readonly onChange: (id: string) => void
  /** A model the provider gave no result for: marked as the permission chip's is, and described by the line that says so. */
  readonly pending?: boolean | undefined; readonly describedBy?: string | undefined
  readonly note?: string | undefined
  readonly unavailable?: readonly UnavailablePickerProvider[] | undefined
  readonly continueOn?: PickerContinuation | undefined
  /** The chip's accessible name, where it chooses something other than this thread's own model. */
  readonly label?: string | undefined
  /** Opens the menu as the chip appears, where a press elsewhere asked for it. */
  readonly openOnMount?: boolean | undefined
  /** Your own model servers' bridge, where this menu may add one: present only on Owl, for a thread on this computer. */
  readonly ownServers?: OwnServersBridge | undefined
}): ReactNode {
  // A long-context variant the catalog does not list (`opus[1m]`) shows as its base model's entry, by that name.
  const current = resolveModel(models, modelId)
  const currentEntryId = catalogEntry(models, modelId)?.id
  const [open, setOpen] = useState(openOnMount && !disabled)
  const [addingServer, setAddingServer] = useState(false)
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  /** The model source whose models are showing, and whose provider it is, so another provider's tile starts on its own sources. */
  const [step, setStep] = useState<{ readonly provider: string; readonly source: string } | null>(null)
  /** The model source row that holds the list's one tab stop, once focus has been on one; until then, the chosen model's. */
  const [sourceStop, setSourceStop] = useState<string | undefined>(undefined)
  /** Where focus goes once the menu has drawn the step a key or a press asked for. */
  const pendingFocus = useRef<{ readonly to: 'search' } | { readonly to: 'model' } | { readonly to: 'source'; readonly name: string } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const groups = useMemo(() => {
    if (!open) return []
    const result = groupModels(models, model => model.provider)
    return [...[...result].map(([name, items]) => ({ name, providerId: items[0]?.providerId, models: newestModelsFirst(items), sources: modelSources(items, name), reason: undefined as string | undefined })),
      ...unavailable.filter(item => !result.has(item.name)).map(item => ({ name: item.name, providerId: item.providerId, models: [] as AgentModel[], sources: undefined, reason: item.reason as string | undefined }))]
  }, [models, open, unavailable])
  const selectedProvider = groups.find(group => group.name === provider) ?? groups.find(group => group.name === current?.provider) ?? groups[0]
  const filtered = selectedProvider?.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const sources = selectedProvider?.sources
  const sourceWords = query.toLowerCase().split(/\s+/u).filter(Boolean)
  // Across every source at once, matching the source's name too, so "anthropic" finds all of Anthropic's models. Each word
  // matches on its own, so "anthropic sonnet" finds Anthropic's Sonnets though no one name holds both words side by side.
  const found = sources && sourceWords.length ? sources.map(source => ({ ...source, models: source.models.filter(model => {
    const text = `${model.name} ${model.id} ${source.name}`.toLowerCase()
    return sourceWords.every(word => text.includes(word))
  }) })).filter(source => source.models.length) : undefined
  const openSource = sources && step?.provider === selectedProvider?.name ? sources.find(source => source.name === step?.source) : undefined
  // A source that leaves while it is open (its sign-in ends, the folder reconnects without it) is forgotten, so its
  // return shows the sources rather than reopening it unasked.
  useLayoutEffect(() => { if (step && !openSource) setStep(null) }, [step, openSource])
  const holdsChosen = (source: ModelSourceGroup): boolean => source.models.some(model => model.id === currentEntryId)
  const stopSource = sources?.find(source => source.name === sourceStop)?.name ?? sources?.find(holdsChosen)?.name ?? sources?.[0]?.name
  const showProvider = (name: string): void => { setProvider(name); if (name !== selectedProvider?.name) setStep(null) }
  const leaveSource = (): void => { if (openSource) pendingFocus.current = { to: 'source', name: openSource.name }; setStep(null) }
  const continuing = selectedProvider !== undefined && continueOn?.providers.has(selectedProvider.name) === true
  // Each turn of the wheel over the rail steps one provider and stops at either end. A turn ends when the wheel
  // rests for a moment or turns the other way, so a mouse notch is a step and so is a touchpad swipe with its
  // momentum, whose small movements add up to one. A turn is kept across renders, since the owner may hand over a
  // fresh list of the same models at any time, and starts afresh when the menu opens. Each step moves on from the
  // last one at once, so turns that land before the menu redraws are not lost. Zoom, a pinch and sideways
  // scrolling keep their own meaning. React registers wheel listeners as passive, so the rail would scroll
  // instead without this. Focus on the rail moves with the choice, so its one tab stop stays on it.
  const selectedName = selectedProvider?.name
  const wheelTurn = useRef(restingWheel())
  const wheelChoice = useRef(selectedName)
  useEffect(() => {
    wheelChoice.current = selectedName
    const element = rail.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return
      event.preventDefault()
      const now = performance.now(), direction = Math.sign(event.deltaY), turn = wheelTurn.current
      if (now - turn.at > RAIL_WHEEL_PAUSE || direction !== turn.direction) wheelTurn.current = { ...restingWheel(), direction }
      wheelTurn.current.at = now
      if (wheelTurn.current.stepped) return
      wheelTurn.current.travel += Math.abs(event.deltaY)
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && wheelTurn.current.travel < RAIL_WHEEL_STEP) return
      wheelTurn.current.stepped = true
      const at = groups.findIndex(group => group.name === wheelChoice.current)
      const next = Math.max(0, Math.min(groups.length - 1, at + direction))
      const group = groups[next]
      if (!group || group.name === wheelChoice.current) return
      wheelChoice.current = group.name
      const tile = element.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
      tile?.scrollIntoView?.({ block: 'nearest' })
      if (element.contains(document.activeElement)) tile?.focus()
      else { setProvider(group.name); setStep(null) }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [groups, selectedName])
  const placeMenu = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    element.showModal?.()
    if (!element.open) element.setAttribute('open', '')
    // Anchored over the chip, below it only when there is room, and kept inside the window as it resizes. Where it fits
    // on neither side, as in a small window with the composer mid-way down, it takes the roomier side and is shortened to
    // fit there, so it never covers the chip it came from. Once open it keeps its side and holds the chip's edge: a menu
    // above its chip keeps its foot there and grows and shrinks upward, one below keeps its head there and grows
    // downward. It changes sides only when it no longer fits on its own.
    let side: 'below' | 'above' | undefined
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      element.style.maxHeight = ''
      const width = element.offsetWidth || 336
      const natural = element.offsetHeight || 360
      const room = { below: innerHeight - anchor.bottom - 22, above: anchor.top - 22 }
      if (!side || natural > room[side]) side = natural <= room.below ? 'below' : natural <= room.above ? 'above' : room.below > room.above ? 'below' : 'above'
      const fit = Math.max(room[side], 160)
      if (natural > fit) element.style.maxHeight = `${fit}px`
      const height = Math.min(natural, fit)
      const top = Math.max(16, Math.min(side === 'below' ? anchor.bottom + 6 : anchor.top - height - 6, innerHeight - height - 16))
      element.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - width - 16))}px`
      // The edge against the chip is the one set, so the menu's own height moves only its far edge. The other is set to
      // auto, since a modal dialog's own style pins both to the window.
      element.style.top = side === 'below' ? `${top}px` : 'auto'
      element.style.bottom = side === 'above' ? `${innerHeight - top - height}px` : 'auto'
    }
    place()
    placeMenu.current = place
    addEventListener('resize', place)
    search.current?.focus()
    return () => { removeEventListener('resize', place); placeMenu.current = undefined; element.close?.(); trigger.current?.focus() }
  }, [open])
  // A step of the menu can be taller or shorter than the last (a provider's model sources, then one source's models),
  // so each draw places it again before it shows, keeping it clear of the chip.
  useLayoutEffect(() => { placeMenu.current?.() })
  // The step a key or a press asked for has drawn: focus what it said. A source with no model to choose yet puts focus on
  // its back control. Whatever the step, focus stays in the menu: where what held it has gone (a source that left, a
  // model that went), it goes to search, so Escape still steps back rather than reaching the window behind.
  useLayoutEffect(() => {
    if (!open) return
    const target = pendingFocus.current
    pendingFocus.current = null
    if (target?.to === 'search') search.current?.focus()
    else if (target) {
      const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (target.to === 'model') (items.find(item => item.getAttribute('aria-selected') === 'true') ?? items[0] ?? back.current)?.focus()
      else items.find(item => item.dataset.source === target.name)?.focus()
    }
    if (dialog.current && !dialog.current.contains(document.activeElement)) search.current?.focus()
  })
  // Escape steps back one level where the menu has levels, and is taken here, before the dialog would close on it.
  const stepBack = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape' || !sources || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (query) { setQuery(''); pendingFocus.current = { to: 'search' } }
    else if (openSource) leaveSource()
    else setOpen(false)
  }
  const name = current?.name ?? (modelId || 'Choose a model')
  const spoken = current?.source ? `${current.name} from ${current.source}, in ${current.provider}` : name
  const option = (model: AgentModel): ReactNode => <button type="button" role="option" key={model.id} aria-selected={model.id === currentEntryId} disabled={disabled || !model.ready}
    onClick={() => { onChange(model.id); setOpen(false) }}><span>{model.name}{!model.ready && <small>Unavailable</small>}</span>{model.id === currentEntryId && <Check size={14} aria-hidden="true" />}</button>
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker__trigger thread-chip tt-focusable" role="combobox" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      title={spoken} data-source={current?.source} aria-describedby={pending ? describedBy : undefined} data-pending={pending ? 'true' : undefined} disabled={disabled} onClick={() => { setProvider(current?.provider ?? groups[0]?.name ?? ''); setQuery(''); setStep(null); setSourceStop(undefined); wheelTurn.current = restingWheel(); setOpen(true) }}>
      {pending ? <i className="thread-chip__pending" aria-hidden="true" /> : null}
      {current ? <ProviderMark provider={current.providerId} name={current.provider} size={13} /> : null}
      {current?.source ? <span className="model-picker__path"><span className="model-picker__source" data-long={current.source.length > LONG_SOURCE || undefined}>{current.source}</span><span className="model-picker__separator" aria-hidden="true">/</span><span className="model-picker__name">{name}</span></span> : <span>{name}</span>}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <dialog ref={dialog} id={dialogId} className="model-picker__dialog" aria-label="Choose model" data-rail={groups.length > 1 || undefined}
      onKeyDown={stepBack}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      onClick={event => { if (event.target === event.currentTarget) setOpen(false); event.stopPropagation() }}>
      {/* One tab stop for the whole rail: the arrows move along it and the tile they land on becomes the list. */}
      {groups.length > 1 && <div ref={rail} className="model-picker__rail" role="tablist" aria-label="Model providers" aria-orientation="vertical"
        onKeyDown={event => moveListboxFocus(event, rail.current)}>
        {groups.map(group => {
          const chosen = selectedProvider?.name === group.name
          return <button type="button" role="tab" key={group.name} aria-label={group.name} title={group.name} aria-selected={chosen} tabIndex={chosen ? 0 : -1}
            onFocus={() => showProvider(group.name)} onClick={() => { showProvider(group.name); search.current?.focus() }}>
            <ProviderMark provider={group.providerId} name={group.name} size={18} /></button>
        })}
      </div>}
      <div className="model-picker__panel">
        <header className="model-picker__search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label="Search models" placeholder={!selectedProvider ? 'Search models' : sources ? `Search all ${selectedProvider.name} models` : `Search ${selectedProvider.name} models`} value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.preventDefault()
            if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
          }} />
          {found ? <span className="model-picker__count">{countModels(found.reduce((sum, source) => sum + source.models.length, 0))}</span> : null}
          <button type="button" aria-label="Close model picker" title="Close model picker" onClick={() => setOpen(false)}><X size={15} aria-hidden="true" /></button>
        </header>
        {continuing ? <p className="model-picker__heading">{continueOn!.heading(selectedProvider!.name)}</p> : null}
        {!sources ? <div ref={list} role="listbox" aria-label={`${selectedProvider?.name ?? ''} models`} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
          {filtered.map(option)}
          {selectedProvider?.reason !== undefined ? <p className="model-picker__empty" role="note">{selectedProvider.reason}</p>
            : !filtered.length && <p className="model-picker__empty">No matching models.</p>}
        </div>
          : found ? <div ref={list} role="listbox" aria-label={`${selectedProvider!.name} models`} className="model-picker__models model-picker__models--grouped" onKeyDown={event => moveListboxFocus(event, list.current)}>
            {found.map(source => <div key={source.name} role="group" aria-label={source.name}>
              <p className="model-picker__group" aria-hidden="true">{source.name}<span>{source.models.length}</span></p>
              {source.models.map(option)}
            </div>)}
            {!found.length && <p className="model-picker__empty">No matching models.</p>}
          </div>
          : openSource ? <>
            <div className="model-picker__step">
              <button ref={back} type="button" aria-label="Back to model sources" title="Back to model sources" onClick={leaveSource}><ChevronLeft size={14} aria-hidden="true" />Model sources</button>
              <b>{openSource.name}</b><span>{countModels(openSource.models.length)}</span>
            </div>
            <div ref={list} role="listbox" aria-label={`${openSource.name} models`} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
              {openSource.models.map(option)}
            </div>
          </>
          // One tab stop, as the rail is: the arrows move along it, and Up from the first row goes back to search.
          : <div ref={list} role="group" aria-label={`${selectedProvider!.name} model sources`} className="model-picker__models model-picker__sources" onKeyDown={event => moveListboxFocus(event, list.current, search.current)}>
            {sources.map(source => {
              const about = `${countModels(source.models.length)}${source.name === OPENCODE_ZEN_SOURCE ? ' · Free with OpenCode Zen' : ''}`
              return <button type="button" key={source.name} data-source={source.name} aria-current={holdsChosen(source) || undefined} tabIndex={source.name === stopSource ? 0 : -1}
                aria-label={`Show ${source.name} models, ${about.replace(' · ', ', ')}`} onFocus={() => setSourceStop(source.name)} onClick={() => { pendingFocus.current = { to: 'model' }; setStep({ provider: selectedProvider!.name, source: source.name }) }}>
                <span><b>{source.name}</b><small>{about}</small></span><ChevronRight size={14} aria-hidden="true" />
              </button>
            })}
            {ownServers && selectedProvider?.providerId === 'opencode' ? <OwnServerMenuEntry onPress={() => { setOpen(false); setAddingServer(true) }} /> : null}
          </div>}
        {continuing ? <p className="model-picker__note">{continueOn!.note}</p> : note ? <p className="model-picker__note">{note}</p> : null}
      </div>
    </dialog>}
    {addingServer && ownServers ? <AddOwnServerDialog bridge={ownServers} fallbackFocus={trigger} confirm onClose={() => setAddingServer(false)} /> : null}
  </div>
}
