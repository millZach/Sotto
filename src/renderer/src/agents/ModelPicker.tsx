import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import type { AgentModel } from '../../../shared/agents'
import { catalogEntry, resolveModel } from '../../../shared/modelCatalog'
import { moveListboxFocus } from './listboxKeys'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { ProviderMark } from './ProviderMark'
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

/**
 * The model control: a chip carrying the provider's mark and the model's name, which opens a compact menu
 * anchored over it. The menu is two columns. On the left a rail of provider marks, one tile each and no
 * names, so the menu costs the same whatever a provider is called; the name is the tile's accessible name
 * and its tooltip. On the right the chosen provider's models under a search line, with `note` beneath them
 * -- the reminder that a new thread may still change provider, or that this one may not. The wheel over the
 * rail steps through the providers as its arrow keys do. A single provider has no rail. Escape, a click
 * outside or a choice closes the menu and returns focus to the chip; a choice shows on the chip at once while
 * the owner saves it.
 */
export function ModelPicker({ models, modelId, disabled, onChange, note }: {
  readonly models: AgentModel[]; readonly modelId: string; readonly disabled: boolean; readonly onChange: (id: string) => void
  readonly note?: string | undefined
}): ReactNode {
  // A long-context variant the catalog does not list (`opus[1m]`) shows as its base model's entry, by that name.
  const current = resolveModel(models, modelId)
  const currentEntryId = catalogEntry(models, modelId)?.id
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const dialogId = useId()
  const groups = useMemo(() => {
    if (!open) return []
    const result = new Map<string, AgentModel[]>()
    for (const model of models) {
      const group = result.get(model.provider)
      if (group) group.push(model)
      else result.set(model.provider, [model])
    }
    return [...result].map(([name, items]) => ({ name, providerId: items[0]?.providerId, models: newestModelsFirst(items) }))
  }, [models, open])
  const selectedProvider = groups.find(group => group.name === provider) ?? groups.find(group => group.name === current?.provider) ?? groups[0]
  const filtered = selectedProvider?.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase())) ?? []
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
      else setProvider(group.name)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [groups, selectedName])
  useLayoutEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    element.showModal?.()
    if (!element.open) element.setAttribute('open', '')
    // Anchored over the chip, below it only when there is room, and kept inside the window as it resizes.
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const width = element.offsetWidth || 336
      const height = element.offsetHeight || 360
      const below = innerHeight - anchor.bottom - 16
      const top = below >= height ? anchor.bottom + 6 : anchor.top - height - 6
      element.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - width - 16))}px`
      element.style.top = `${Math.max(16, Math.min(top, innerHeight - height - 16))}px`
    }
    place()
    addEventListener('resize', place)
    search.current?.focus()
    return () => { removeEventListener('resize', place); element.close?.(); trigger.current?.focus() }
  }, [open])
  const name = current?.name ?? (modelId || 'Choose a model')
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker__trigger thread-chip tt-focusable" role="combobox" aria-label={OPTION_CHIP_NAMES.model} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      title={name} disabled={disabled} onClick={() => { setProvider(current?.provider ?? groups[0]?.name ?? ''); setQuery(''); wheelTurn.current = restingWheel(); setOpen(true) }}>
      {current ? <ProviderMark provider={current.providerId} name={current.provider} size={13} /> : null}<span>{name}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <dialog ref={dialog} id={dialogId} className="model-picker__dialog" aria-label="Choose model" data-rail={groups.length > 1 || undefined}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      onClick={event => { if (event.target === event.currentTarget) setOpen(false); event.stopPropagation() }}>
      {/* One tab stop for the whole rail: the arrows move along it and the tile they land on becomes the list. */}
      {groups.length > 1 && <div ref={rail} className="model-picker__rail" role="tablist" aria-label="Model providers" aria-orientation="vertical"
        onKeyDown={event => moveListboxFocus(event, rail.current)}>
        {groups.map(group => {
          const chosen = selectedProvider?.name === group.name
          return <button type="button" role="tab" key={group.name} aria-label={group.name} title={group.name} aria-selected={chosen} tabIndex={chosen ? 0 : -1}
            onFocus={() => setProvider(group.name)} onClick={() => { setProvider(group.name); search.current?.focus() }}>
            <ProviderMark provider={group.providerId} name={group.name} size={18} /></button>
        })}
      </div>}
      <div className="model-picker__panel">
        <header className="model-picker__search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label="Search models" placeholder={selectedProvider ? `Search ${selectedProvider.name} models` : 'Search models'} value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.preventDefault()
            if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
          }} />
          <button type="button" aria-label="Close model picker" title="Close model picker" onClick={() => setOpen(false)}><X size={15} aria-hidden="true" /></button>
        </header>
        <div ref={list} role="listbox" aria-label={`${selectedProvider?.name ?? ''} models`} className="model-picker__models" onKeyDown={event => moveListboxFocus(event, list.current)}>
          {filtered.map(model => <button type="button" role="option" key={model.id} aria-selected={model.id === currentEntryId} disabled={disabled || !model.ready}
            onClick={() => { onChange(model.id); setOpen(false) }}><span>{model.name}{!model.ready && <small>Unavailable</small>}</span>{model.id === currentEntryId && <Check size={14} aria-hidden="true" />}</button>)}
          {!filtered.length && <p className="model-picker__empty">No matching models.</p>}
        </div>
        {note ? <p className="model-picker__note">{note}</p> : null}
      </div>
    </dialog>}
  </div>
}
