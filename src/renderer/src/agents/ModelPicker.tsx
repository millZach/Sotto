import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Star, X } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { OPENCODE_ZEN_SOURCE, type AgentModel, type ProviderId } from '../../../shared/agents'
import type { OwnServersBridge } from '../../../shared/ownModelServers'
import { catalogEntry, resolveModel } from '../../../shared/modelCatalog'
import { compareVersions, inLineup, LINEUP_PROVIDERS, modelVersion } from '../../../shared/modelLineup'
import { useOwlFeature } from '../state/owlFeature'
import { useAnchoredMenu } from './anchoredMenu'
import { moveListboxFocus } from './listboxKeys'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { ProviderMark } from './ProviderMark'
import { AddOwnServerDialog, OwnServerMenuEntry } from './OwnModelServers'
import { favoriteKey, toggleModelFavorite, useModelFavorites, type ModelFavorite } from './modelFavorites'
import './threadChips.css'
import './modelPicker.css'

/** How far a touchpad moves, in pixels, to step the provider rail once; a mouse notch is more than this. */
const RAIL_WHEEL_STEP = 40
/** The quiet, in milliseconds, that ends one turn of the wheel: a swipe and its momentum are one turn. */
const RAIL_WHEEL_PAUSE = 150

/** One turn of the wheel over the provider rail: when it last moved, which way, how far, and whether it has stepped. */
interface RailWheelTurn { at: number; direction: number; travel: number; stepped: boolean }
const restingWheel = (): RailWheelTurn => ({ at: -Infinity, direction: 0, travel: 0, stepped: false })
/** The Favorites tile's place among the rail's provider names; no provider is called this. */
const FAVORITES = '\u0000favorites'
const noFavorites: readonly ModelFavorite[] = []
const noUnavailable: readonly UnavailablePickerProvider[] = []

/**
 * Newest first, with the model the provider itself recommends kept at the top whatever it is called. The
 * recommendation is the provider's own answer to the question the list is asking, so it does not compete on
 * version number: "Default (recommended)" carries no version and would otherwise sort below everything.
 */
export function newestModelsFirst(models: readonly AgentModel[]): AgentModel[] {
  return [...models].sort((left, right) => {
    if (Boolean(left.recommended) !== Boolean(right.recommended)) return left.recommended ? -1 : 1
    return compareVersions(modelVersion(right), modelVersion(left))
  })
}

/**
 * A Claude Code or Codex menu's models (ADR-0171): only the ready ones, the newest of each line first and the legacy ones
 * apart, each newest first. A starred legacy model stays with the newest. Undefined for any other provider's models.
 */
export function lineupModels(models: readonly AgentModel[], starred: (model: AgentModel) => boolean): { readonly latest: AgentModel[]; readonly legacy: AgentModel[] } | undefined {
  if (!models[0] || !inLineup(models[0])) return undefined
  const latest: AgentModel[] = [], legacy: AgentModel[] = []
  for (const model of models) if (model.ready) (model.legacy && !starred(model) ? legacy : latest).push(model)
  return { latest: newestModelsFirst(latest), legacy: newestModelsFirst(legacy) }
}

/** "Legacy", the name of the section that holds a Claude Code or Codex provider's older models (ADR-0171). */
export function useLegacyName(): string {
  const { t } = useLingui()
  return t({ message: 'Legacy', comment: 'In the model menu: the older models of a provider, kept apart from its newest.' })
}

/** The closed row under a Claude Code or Codex list that opens its legacy models in place, with how many there are. */
export function LegacyRow({ open, count, onToggle }: { readonly open: boolean; readonly count: number; readonly onToggle: () => void }): ReactNode {
  return <button type="button" className="model-picker__legacy" aria-expanded={open} onClick={onToggle}>
    {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}{useLegacyName()}<span>{countModels(count)}</span>
  </button>
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
 * model without a source among ones that have one goes under the provider's own name. Cursor's groups are its model
 * makers (ADR-0128), which arrive in Cursor's order, Cursor's own Auto and Composer first, and are kept in it, models too.
 */
export function modelSources(models: readonly AgentModel[], provider: string): ModelSourceGroup[] | undefined {
  if (!models.some(model => model.source !== undefined)) return undefined
  const byMaker = makerGrouped(models)
  return [...groupModels(models, model => model.source ?? provider)].map(([name, items]) => ({ name, models: byMaker ? items : newestModelsFirst(items) }))
    .sort((left, right) => Number(right.name === OPENCODE_ZEN_SOURCE) - Number(left.name === OPENCODE_ZEN_SOURCE))
}

/** Whether a provider's groups are model makers rather than model sources: Cursor's are (ADR-0128). */
const makerGrouped = (models: readonly AgentModel[]): boolean => models[0]?.providerId === 'cursor'

/** A model source name longer than this many characters may give way on the chip, down to a floor; a shorter one never does. */
const LONG_SOURCE = 9

/** What a search line holds, as the words a model must match, each on its own. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/u).filter(Boolean)
/** Whether every search word is somewhere in `text`, so "anthropic sonnet" finds Anthropic's Sonnets. */
export const matchesWords = (text: string, words: readonly string[]): boolean => {
  const lower = text.toLowerCase()
  return words.every(word => lower.includes(word))
}

export const countModels = (count: number): string => plural(count, { one: '# model', other: '# models' })

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
 *
 * On Owl (ADR-0147), the rail starts with Favorites: every model the user starred, from any provider or source, each with
 * its provider's mark. A star on each model row, or F on a focused one, stars it or takes the star off. The menu opens on
 * Favorites while any exist. A favorite whose provider or model has gone stays listed, unavailable, and can be unstarred.
 * Typing there searches every provider's models.
 */
export function ModelPicker({ models, modelId, disabled, onChange, note, unavailable = noUnavailable, continueOn, label = OPTION_CHIP_NAMES.model, openOnMount = false, pending = false, describedBy, ownServers }: {
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
  const { t } = useLingui()
  // A long-context variant the catalog does not list (`opus[1m]`) shows as its base model's entry, by that name.
  const current = resolveModel(models, modelId)
  const currentEntryId = catalogEntry(models, modelId)?.id
  const [open, setOpen] = useState(openOnMount && !disabled)
  const [addingServer, setAddingServer] = useState(false)
  const favoritesOn = useOwlFeature('model-favorites')
  const stored = useModelFavorites()
  // Only the favorites of providers this menu offers: a menu that lists some providers (continuing a thread, a worker role)
  // leaves the rest out rather than calling them unavailable.
  const favorites = useMemo(() => {
    if (!favoritesOn) return noFavorites
    const offered = new Set([...models.map(model => model.provider), ...unavailable.map(item => item.name)])
    return stored.filter(favorite => offered.has(favorite.provider))
  }, [favoritesOn, stored, models, unavailable])
  const [provider, setProvider] = useState('')
  /** Whether Favorites is the rail's chosen tile, which it is only while the menu has a rail. */
  const [onFavorites, setOnFavorites] = useState(() => favorites.length > 0)
  const [query, setQuery] = useState('')
  /** The model source whose models are showing, and whose provider it is, so another provider's tile starts on its own sources. */
  const [step, setStep] = useState<{ readonly provider: string; readonly source: string } | null>(null)
  /** The model source row that holds the list's one tab stop, once focus has been on one; until then, the chosen model's. */
  const [sourceStop, setSourceStop] = useState<string | undefined>(undefined)
  /** Where focus goes once the menu has drawn the step a key or a press asked for. */
  const pendingFocus = useRef<{ readonly to: 'search' } | { readonly to: 'model' } | { readonly to: 'source'; readonly name: string } | { readonly to: 'row'; readonly index: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  /** Whether the press now ending began on the backdrop, outside every part of the menu. */
  const pressedBackdrop = useRef(false)
  const favoriteKeys = useMemo(() => new Set(favorites.map(favoriteKey)), [favorites])
  const groups = useMemo(() => {
    if (!open) return []
    const result = groupModels(models, model => model.provider)
    const none: AgentModel[] = []
    return [...[...result].map(([name, items]) => {
      const lineup = lineupModels(items, model => favoriteKeys.has(favoriteKey(model)))
      // A provider whose menu leads with its newest models lists none it cannot run now, and says why instead (ADR-0171).
      if (lineup) return { name, providerId: items[0]?.providerId, models: lineup.latest, legacy: lineup.legacy, sources: undefined,
        reason: lineup.latest.length ? undefined : t({ message: `${name} is not connected. Connect it in Settings › Providers to choose a model.`, comment: '{name} is a provider, such as Claude Code or Codex.' }) as string | undefined }
      return { name, providerId: items[0]?.providerId, models: newestModelsFirst(items), legacy: none, sources: modelSources(items, name), reason: undefined as string | undefined }
    }), ...unavailable.filter(item => !result.has(item.name)).map(item => ({ name: item.name, providerId: item.providerId, models: none, legacy: none, sources: undefined, reason: item.reason as string | undefined }))]
  }, [models, open, unavailable, favoriteKeys, t])
  const favoritesTile = favoritesOn && groups.length > 1
  const favoritesPane = favoritesTile && onFavorites
  const selectedProvider = favoritesPane ? undefined : groups.find(group => group.name === provider) ?? groups.find(group => group.name === current?.provider) ?? groups[0]
  /** The rail's tiles by name, Favorites first where it has one. */
  const tiles = useMemo(() => [...(favoritesTile ? [FAVORITES] : []), ...groups.map(group => group.name)], [favoritesTile, groups])
  const liveModels = useMemo(() => new Map(models.map(model => [favoriteKey(model), model])), [models])
  const matchesQuery = (model: AgentModel): boolean => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase())
  const filtered = selectedProvider?.models.filter(matchesQuery) ?? []
  // Legacy models are found by a search; otherwise they wait under the Legacy row until it is opened.
  const legacy = selectedProvider?.legacy ?? []
  const legacyFound = query ? legacy.filter(matchesQuery) : legacy
  const [legacyOpen, setLegacyOpen] = useState(false)
  const legacyName = useLegacyName()
  const sources = selectedProvider?.sources
  const makers = sources !== undefined && selectedProvider?.providerId === 'cursor'
  // The words a menu of Cursor's model makers uses where a menu of model sources uses its own (ADR-0128).
  const backToMakers = t`Back to Cursor’s model makers`
  const makerModels = (maker: string): string => t({ message: `${maker} models in Cursor`, comment: '{maker} is the company that made the models, such as Anthropic.' })
  const sourceWords = searchWords(query)
  // Across every source at once, matching the source's name too, so "anthropic" finds all of Anthropic's models. Each word
  // matches on its own, so "anthropic sonnet" finds Anthropic's Sonnets though no one name holds both words side by side.
  const found = sources && sourceWords.length ? sources.map(source => ({ ...source, models: source.models.filter(model => matchesWords(`${model.name} ${model.id} ${source.name}`, sourceWords)) }))
    .filter(source => source.models.length) : undefined
  const openSource = sources && step?.provider === selectedProvider?.name ? sources.find(source => source.name === step?.source) : undefined
  // A source that leaves while it is open (its sign-in ends, the folder reconnects without it) is forgotten, so its
  // return shows the sources rather than reopening it unasked.
  useLayoutEffect(() => { if (step && !openSource) setStep(null) }, [step, openSource])
  const holdsChosen = (source: ModelSourceGroup): boolean => source.models.some(model => model.id === currentEntryId)
  const stopSource = sources?.find(source => source.name === sourceStop)?.name ?? sources?.find(holdsChosen)?.name ?? sources?.[0]?.name
  const showProvider = (name: string): void => { setProvider(name); setOnFavorites(false); if (name !== selectedProvider?.name) setStep(null) }
  const showFavorites = (): void => { setOnFavorites(true); setStep(null) }
  // Typing on Favorites searches every provider's models, under each provider's name.
  const everywhere = favoritesPane && sourceWords.length ? groups.map(group => ({ name: group.name, models: [...group.models, ...group.legacy].filter(model => matchesWords(`${model.name} ${model.id} ${model.source ?? ''} ${group.name}`, sourceWords)) }))
    .filter(group => group.models.length) : undefined
  const favoritesContinue = favoritesPane && !everywhere && continueOn !== undefined && favorites.some(favorite => continueOn.providers.has(favorite.provider))
  const leaveSource = (): void => { if (openSource) pendingFocus.current = { to: 'source', name: openSource.name }; setStep(null) }
  const continuing = favoritesContinue || selectedProvider !== undefined && continueOn?.providers.has(selectedProvider.name) === true
  // Each turn of the wheel over the rail steps one provider and stops at either end. A turn ends when the wheel
  // rests for a moment or turns the other way, so a mouse notch is a step and so is a touchpad swipe with its
  // momentum, whose small movements add up to one. A turn is kept across renders, since the owner may hand over a
  // fresh list of the same models at any time, and starts afresh when the menu opens. Each step moves on from the
  // last one at once, so turns that land before the menu redraws are not lost. Zoom, a pinch and sideways
  // scrolling keep their own meaning. React registers wheel listeners as passive, so the rail would scroll
  // instead without this. Focus on the rail moves with the choice, so its one tab stop stays on it.
  const selectedName = favoritesPane ? FAVORITES : selectedProvider?.name
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
      const at = tiles.indexOf(wheelChoice.current ?? '')
      const next = Math.max(0, Math.min(tiles.length - 1, at + direction))
      const name = tiles[next]
      if (name === undefined || name === wheelChoice.current) return
      wheelChoice.current = name
      const tile = element.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
      tile?.scrollIntoView?.({ block: 'nearest' })
      if (element.contains(document.activeElement)) tile?.focus()
      else { if (name === FAVORITES) setOnFavorites(true); else { setProvider(name); setOnFavorites(false) } setStep(null) }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [tiles, selectedName])
  useAnchoredMenu(open, trigger, dialog, search)
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
      else if (target.to === 'row') items[Math.min(target.index, items.length - 1)]?.focus()
      else items.find(item => item.dataset.source === target.name)?.focus()
    }
    if (dialog.current && !dialog.current.contains(document.activeElement)) search.current?.focus()
  })
  // Escape steps back one level where the menu has levels, and is taken here, before the dialog would close on it.
  const stepBack = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape' || !sources && !favoritesPane || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (query) { setQuery(''); pendingFocus.current = { to: 'search' } }
    else if (openSource) leaveSource()
    else setOpen(false)
  }
  const name = current?.name ?? (modelId || t`Choose a model`)
  const spokenSource = current?.source
  const spokenProvider = current?.provider ?? ''
  const spoken = spokenSource ? t({ message: `${name} from ${spokenSource}, in ${spokenProvider}`, comment: 'The model chip\'s tooltip: a model, the model source it comes from, and the provider that runs it.' }) : name
  // Starring a row on Favorites takes it away, so focus moves to the row that takes its place.
  const star = (model: AgentModel, row: HTMLElement): void => {
    if (favoritesPane && !everywhere) pendingFocus.current = { to: 'row', index: [...(list.current?.querySelectorAll('button:not(:disabled)') ?? [])].indexOf(row) }
    toggleModelFavorite(model)
  }
  /**
   * A model's row. On Favorites (`favorite`) it carries its provider's mark and source, and one that cannot be chosen is
   * still focusable, so its star can come off.
   */
  const option = (model: AgentModel, favorite = false): ReactNode => {
    const starred = favoriteKeys.has(favoriteKey(model))
    const unready = disabled || !model.ready
    const starName = starred ? t`Remove from favorites` : t`Add to favorites`
    return <button type="button" role="option" key={favorite ? favoriteKey(model) : model.id} aria-selected={model.id === currentEntryId} disabled={unready && !favorite} aria-disabled={favorite && unready || undefined} data-favorite={favorite || undefined}
      aria-keyshortcuts={favoritesOn ? 'F' : undefined} aria-description={favorite ? continueOn?.providers.has(model.provider) ? continueOn.heading(model.provider) : model.provider : undefined}
      onKeyDown={event => { if (favoritesOn && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); star(model, event.currentTarget) } }}
      onClick={() => { if (unready) return; onChange(model.id); setOpen(false) }}>
      <span>{favorite ? <ProviderMark provider={model.providerId} name={model.provider} size={12} /> : null}{model.name}{favorite && model.source ? <small>{model.source}</small> : null}{!model.ready && <small>{t({ message: 'Unavailable', comment: 'Beside a model that cannot be chosen now.' })}</small>}</span>
      {model.id === currentEntryId && <Check size={14} aria-hidden="true" />}
      {/* Hidden from the row's name: F does the same from the keyboard, and the row's own name stays the model's. */}
      {favoritesOn ? <span className="model-picker__star" data-starred={starred || undefined} title={starName} aria-hidden="true"
        onClick={event => { event.stopPropagation(); star(model, event.currentTarget.parentElement!) }}><Star size={13} fill={starred ? 'currentColor' : 'none'} /></span> : null}
    </button>
  }
  const providerName = selectedProvider?.name ?? ''
  const openSourceName = openSource?.name ?? ''
  const providerModels = t({ message: `${providerName} models`, comment: '{providerName} is a provider\'s name.' })
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker__trigger thread-chip tt-focusable" role="combobox" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      title={spoken} data-source={current?.source} aria-describedby={pending ? describedBy : undefined} data-pending={pending ? 'true' : undefined} disabled={disabled} onClick={() => { setProvider(current?.provider ?? groups[0]?.name ?? ''); setOnFavorites(favorites.length > 0); setQuery(''); setStep(null); setSourceStop(undefined); setLegacyOpen(current?.legacy === true); wheelTurn.current = restingWheel(); setOpen(true) }}>
      {pending ? <i className="thread-chip__pending" aria-hidden="true" /> : null}
      {current ? <ProviderMark provider={current.providerId} name={current.provider} size={13} /> : null}
      {current?.source ? <span className="model-picker__path"><span className="model-picker__source" data-long={current.source.length > LONG_SOURCE || undefined}>{current.source}</span><span className="model-picker__separator" aria-hidden="true">/</span><span className="model-picker__name">{name}</span></span> : <span>{name}</span>}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <dialog ref={dialog} id={dialogId} className="model-picker__dialog" aria-label={t`Choose model`} data-rail={groups.length > 1 || undefined}
      onKeyDown={stepBack}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      // A click outside closes the menu only when its press began outside too. A press on a provider tile can change the
      // menu's height, and a menu above its chip moves its top edge, so the release may land beyond the menu; the click
      // then goes to the dialog itself, and closing on it would close the menu on the tile the user pressed.
      onPointerDown={event => { pressedBackdrop.current = event.target === event.currentTarget }}
      onClick={event => { if (event.target === event.currentTarget && pressedBackdrop.current) setOpen(false); pressedBackdrop.current = false; event.stopPropagation() }}>
      {/* One tab stop for the whole rail: the arrows move along it and the tile they land on becomes the list. */}
      {groups.length > 1 && <div ref={rail} className="model-picker__rail" role="tablist" aria-label={t`Model providers`} aria-orientation="vertical"
        onKeyDown={event => moveListboxFocus(event, rail.current)}>
        {favoritesTile ? <button type="button" role="tab" className="model-picker__favorites-tile" aria-label={t`Favorites`} title={t`Favorites`} aria-selected={favoritesPane} tabIndex={favoritesPane ? 0 : -1}
          onFocus={showFavorites} onClick={() => { showFavorites(); search.current?.focus() }}><Star size={17} aria-hidden="true" /></button> : null}
        {groups.map(group => {
          const chosen = selectedProvider?.name === group.name
          return <button type="button" role="tab" key={group.name} aria-label={group.name} title={group.name} aria-selected={chosen} tabIndex={chosen ? 0 : -1}
            onFocus={() => showProvider(group.name)} onClick={() => { showProvider(group.name); search.current?.focus() }}>
            <ProviderMark provider={group.providerId} name={group.name} size={18} /></button>
        })}
      </div>}
      <div className="model-picker__panel">
        <header className="model-picker__search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label={t`Search models`} placeholder={!selectedProvider ? t`Search models` : sources ? t({ message: `Search all ${providerName} models`, comment: '{providerName} is a provider\'s name.' }) : t({ message: `Search ${providerName} models`, comment: '{providerName} is a provider\'s name.' })} value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.preventDefault()
            if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
          }} />
          {found ? <span className="model-picker__count">{countModels(found.reduce((sum, source) => sum + source.models.length, 0))}</span> : null}
          <button type="button" aria-label={t`Close model picker`} title={t`Close model picker`} onClick={() => setOpen(false)}><X size={15} aria-hidden="true" /></button>
        </header>
        {continuing && selectedProvider ? <p className="model-picker__heading">{continueOn!.heading(selectedProvider.name)}</p> : null}
        {everywhere ? <div ref={list} role="listbox" aria-label={t`Models`} className="model-picker__models model-picker__models--grouped" onKeyDown={event => moveListboxFocus(event, list.current)}>
          {everywhere.map(group => <div key={group.name} role="group" aria-label={continueOn?.providers.has(group.name) ? continueOn.heading(group.name) : group.name}>
            <p className="model-picker__group" aria-hidden="true">{continueOn?.providers.has(group.name) ? continueOn.heading(group.name) : group.name}<span>{group.models.length}</span></p>
            {group.models.map(model => option(model))}
          </div>)}
          {!everywhere.length && <p className="model-picker__empty tt-paragraph">{t`No matching models.`}</p>}
        </div>
        : favoritesPane ? <div ref={list} role="listbox" aria-label={t`Favorites`} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
          {favorites.map(favorite => {
            const live = liveModels.get(favoriteKey(favorite))
            // A Claude Code or Codex favourite that cannot be chosen now is left out rather than marked (ADR-0171).
            if (favorite.providerId && LINEUP_PROVIDERS.has(favorite.providerId) && !live?.ready) return null
            return option(live ?? { ...favorite, ready: false }, true)
          })}
          {!favorites.length && <p className="model-picker__empty tt-paragraph">{t`Star a model to keep it here.`}</p>}
        </div>
        : !sources ? <div ref={list} role="listbox" aria-label={providerModels} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
          {filtered.map(model => option(model))}
          {legacyFound.length > 0 && !query ? <LegacyRow open={legacyOpen} count={legacyFound.length} onToggle={() => setLegacyOpen(shown => !shown)} /> : null}
          {legacyFound.length > 0 && query ? <p className="model-picker__group" aria-hidden="true">{legacyName}<span>{legacyFound.length}</span></p> : null}
          {legacyFound.length > 0 && (query || legacyOpen) ? <div role="group" aria-label={legacyName}>{legacyFound.map(model => option(model))}</div> : null}
          {selectedProvider?.reason !== undefined ? <p className="model-picker__empty tt-paragraph" role="note">{selectedProvider.reason}</p>
            : !filtered.length && !legacyFound.length && <p className="model-picker__empty tt-paragraph">{t`No matching models.`}</p>}
        </div>
          : found ? <div ref={list} role="listbox" aria-label={providerModels} className="model-picker__models model-picker__models--grouped" onKeyDown={event => moveListboxFocus(event, list.current)}>
            {found.map(source => <div key={source.name} role="group" aria-label={source.name}>
              <p className="model-picker__group" aria-hidden="true">{source.name}<span>{source.models.length}</span></p>
              {source.models.map(model => option(model))}
            </div>)}
            {!found.length && <p className="model-picker__empty tt-paragraph">{t`No matching models.`}</p>}
          </div>
          : openSource ? <>
            <div className="model-picker__step">
              <button ref={back} type="button" aria-label={makers ? backToMakers : t`Back to model sources`} title={makers ? backToMakers : t`Back to model sources`} onClick={leaveSource}><ChevronLeft size={14} aria-hidden="true" />{makers ? t({ message: 'Makers', comment: 'A back control in the model menu that returns to the list of the companies that made Cursor’s models.' }) : t`Model sources`}</button>
              <b>{openSource.name}</b><span>{countModels(openSource.models.length)}</span>
            </div>
            <div ref={list} role="listbox" aria-label={makers ? makerModels(openSource.name) : t({ message: `${openSourceName} models`, comment: '{openSourceName} is a model source, such as OpenCode Zen or Anthropic.' })} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
              {openSource.models.map(model => option(model))}
            </div>
          </>
          // One tab stop, as the rail is: the arrows move along it, and Up from the first row goes back to search.
          : <div ref={list} role="group" aria-label={makers ? t`Cursor’s model makers` : t({ message: `${providerName} model sources`, comment: '{providerName} is a provider\'s name.' })} className="model-picker__models model-picker__sources" onKeyDown={event => moveListboxFocus(event, list.current, search.current)}>
            {sources.map(source => {
              const modelCount = countModels(source.models.length)
              const sourceName = source.name
              const free = sourceName === OPENCODE_ZEN_SOURCE
              const about = free ? t`${modelCount} · Free with OpenCode Zen` : modelCount
              const spokenAbout = free
                ? t({ message: `Show ${sourceName} models, ${modelCount}, Free with OpenCode Zen`, comment: '{sourceName} is a model source; {modelCount} is how many models it has, such as "3 models".' })
                : t({ message: `Show ${sourceName} models, ${modelCount}`, comment: '{sourceName} is a model source; {modelCount} is how many models it has, such as "3 models".' })
              return <button type="button" key={source.name} data-source={source.name} aria-current={holdsChosen(source) || undefined} tabIndex={source.name === stopSource ? 0 : -1}
                aria-label={spokenAbout} onFocus={() => setSourceStop(source.name)} onClick={() => { pendingFocus.current = { to: 'model' }; setStep({ provider: selectedProvider!.name, source: source.name }) }}>
                <span><b>{source.name}</b><small>{about}</small></span><ChevronRight size={14} aria-hidden="true" />
              </button>
            })}
            {ownServers && selectedProvider?.providerId === 'opencode' ? <OwnServerMenuEntry onPress={() => { setOpen(false); setAddingServer(true) }} /> : null}
          </div>}
        {continuing ? <p className="model-picker__note tt-paragraph">{continueOn!.note}</p> : note || selectedProvider?.providerId === 'cursor'
          ? selectedProvider?.providerId === 'cursor'
            ? <p className="model-picker__note tt-paragraph">{[t`Every model here runs through Cursor, on your Cursor plan.`, note].filter(Boolean).join(' ')}</p>
            : <p className="model-picker__note tt-paragraph">{note}</p> : null}
      </div>
    </dialog>}
    {addingServer && ownServers ? <AddOwnServerDialog bridge={ownServers} fallbackFocus={trigger} confirm onClose={() => setAddingServer(false)} /> : null}
  </div>
}
