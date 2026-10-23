import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlert, RefreshCw } from 'lucide-react'

import type { OpenRouterModelList } from '../../../shared/contracts'
import type { AppSettings, LlmMode, SettingsPatch } from '../../../shared/settings'
import { Field } from './Field'
import { SegmentedControl } from './SegmentedControl'

type Model = { readonly id: string; readonly name: string }
const DEFAULT: Model = { id: '', name: 'Default' }
/** Enough rows to find a model by scrolling; typing narrows the rest. */
const MAX_ROWS = 200

function failureCopy(reason: 'http' | 'network' | 'timeout'): string {
  return reason === 'http'
    ? 'OpenRouter did not send its models. The saved choice still works. Try Refresh.'
    : 'Could not reach OpenRouter. The saved choice still works. Try Refresh.'
}

/** The models whose name or slug holds every word typed, Default first while nothing is typed. */
export function matchModels(models: readonly Model[], query: string): Model[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return [DEFAULT, ...models].slice(0, MAX_ROWS)
  return models.filter(model => {
    const text = `${model.name} ${model.id}`.toLowerCase()
    return words.every(word => text.includes(word))
  }).slice(0, MAX_ROWS)
}

/**
 * Settings → Cleanup's model and mode (Owl `cleanup-model`, ADR-0122). The model is a search box over OpenRouter's
 * text models, read when the box first opens; Default is Sotto's own choice. The mode is how OpenRouter picks a host.
 */
export function CleanupModelFields({ settings, onSave, onListModels }: {
  readonly settings: Pick<AppSettings, 'llmModel' | 'llmMode'>
  readonly onSave: (patch: SettingsPatch) => Promise<boolean> | void
  readonly onListModels: () => Promise<OpenRouterModelList>
}): ReactNode {
  const id = useId()
  const [models, setModels] = useState<readonly Model[] | null>(null)
  const [complete, setComplete] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  const chosen = settings.llmModel === null ? DEFAULT
    : models?.find(model => model.id === settings.llmModel) ?? { id: settings.llmModel, name: settings.llmModel }
  // Only a whole list can say a model is gone; one cut short may hold it on a page not read.
  const gone = settings.llmModel !== null && models !== null && complete && !models.some(model => model.id === settings.llmModel)
  const matches = useMemo(() => matchModels(models ?? [], query), [models, query])

  const load = async (): Promise<void> => {
    const current = request.current += 1
    setLoading(true)
    setFailure(null)
    const result = await onListModels().catch((): OpenRouterModelList => ({ ok: false, reason: 'network' }))
    if (current !== request.current) return
    setLoading(false)
    if (result.ok) { setModels(result.models); setComplete(result.complete) }
    else setFailure(failureCopy(result.reason))
  }

  // Opening is the only thing that reads the list: focus alone, as when tabbing past, asks OpenRouter nothing.
  const show = (typed = ''): void => {
    setQuery(typed)
    setActive(0)
    if (open) return
    // Open upward when the window has more room above the box than below it, as at the minimum size.
    const box = input.current?.getBoundingClientRect()
    setAbove(box !== undefined && innerHeight - box.bottom < 240 && box.top > innerHeight - box.bottom)
    setOpen(true)
    if (models === null && !loading) void load()
  }
  const close = (): void => { setOpen(false); setQuery('') }
  const pick = (model: Model): void => {
    close()
    const next = model.id === '' ? null : model.id
    if (next !== settings.llmModel) void onSave({ llmModel: next })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { show(); return }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(index => matches.length === 0 ? 0 : (index + step + matches.length) % matches.length)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const model = matches[active]
      if (model) pick(model)
    } else if (event.key === 'Escape' && open) {
      // The list answers Escape; the page behind it does not close too.
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  const listId = `${id}-models`
  const optionId = (index: number): string => `${id}-model-${index}`
  useEffect(() => {
    if (open) document.getElementById(`${id}-model-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [id, open, active])
  const descriptionId = `${id}-description`

  return <>
    <div className="tt-field cleanup-model">
      <label className="tt-field__label" htmlFor={`${id}-input`}>Cleanup model</label>
      <p className="tt-field__description" id={descriptionId}>Default is the model Sotto tested for cleanup. If the chosen one fails or runs long, Mercury 2 steps in, or Default when Mercury 2 is the one chosen.</p>
      <div className="cleanup-model__control">
        <input ref={input} id={`${id}-input`} data-setting="cleanup-model" className="tt-input tt-focusable" type="text" role="combobox" autoComplete="off" spellCheck={false}
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={descriptionId}
          {...(open && matches[active] ? { 'aria-activedescendant': optionId(active) } : {})}
          value={open ? query : chosen.name}
          placeholder={open ? 'Search models' : undefined}
          onClick={() => { if (!open) show() }} onBlur={close}
          onChange={event => show(event.currentTarget.value)}
          onKeyDown={onKeyDown} />
        <button type="button" className="cleanup-model__refresh tt-focusable" aria-label="Refresh models" title="Refresh models" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        {open ? <ul className="cleanup-model__list" data-above={above || undefined} id={listId} role="listbox" aria-label="Cleanup models">
          {matches.map((model, index) => <li key={model.id || 'default'} id={optionId(index)} role="option"
            aria-selected={model.id === chosen.id} data-active={index === active || undefined}
            onMouseDown={event => { event.preventDefault(); pick(model) }} onMouseMove={() => setActive(index)}>
            <span className="cleanup-model__name">{model.name}</span>
            {model.id ? <span className="cleanup-model__slug">{model.id}</span> : <span className="cleanup-model__slug">Sotto’s choice</span>}
          </li>)}
          {matches.length === 0 ? <li className="cleanup-model__empty" role="presentation">{loading ? 'Loading models…' : models === null ? 'No models yet.' : 'No model matches.'}</li> : null}
        </ul> : null}
      </div>
    </div>
    {failure === null && !gone ? null : <p className="settings-remote-status settings-remote-status--error" role="status">
      <CircleAlert size={16} aria-hidden="true" />{failure ?? 'OpenRouter no longer lists this model, so Mercury 2 cleans up instead. Choose another.'}
    </p>}
    <Field label="Mode" description="How OpenRouter picks a host. Nitro takes the fastest and may bill at priority rates. Floor takes the cheapest and may run slower.">
      <SegmentedControl setting="cleanup-mode" label="Mode" value={settings.llmMode} onChange={value => void onSave({ llmMode: value as LlmMode })}
        options={[{ value: 'default', label: 'Default' }, { value: 'nitro', label: 'Nitro' }, { value: 'floor', label: 'Floor' }]} />
    </Field>
  </>
}
