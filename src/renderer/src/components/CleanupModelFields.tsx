import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlert, RefreshCw } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { OpenRouterModelList } from '../../../shared/contracts'
import type { AppSettings, LlmMode, SettingsPatch } from '../../../shared/settings'
import { Field } from './Field'
import { SegmentedControl } from './SegmentedControl'

type Model = { readonly id: string; readonly name: string }
/** Sotto's own choice, named in the interface language. */
const defaultModel = (): Model => ({ id: '', name: i18n._(msg({ message: 'Default', comment: 'The cleanup model or mode Sotto chooses itself' })) })
/** Enough rows to find a model by scrolling; typing narrows the rest. */
const MAX_ROWS = 200

function failureCopy(reason: 'http' | 'network' | 'timeout'): string {
  return reason === 'http'
    ? i18n._(msg`OpenRouter did not send its models. The saved choice still works. Try Refresh.`)
    : i18n._(msg`Could not reach OpenRouter. The saved choice still works. Try Refresh.`)
}

/** The models whose name or slug holds every word typed, Default first while nothing is typed. */
export function matchModels(models: readonly Model[], query: string): Model[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return [defaultModel(), ...models].slice(0, MAX_ROWS)
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
  const { t, i18n: { locale } } = useLingui()
  const id = useId()
  const [models, setModels] = useState<readonly Model[] | null>(null)
  const [complete, setComplete] = useState(false)
  const [loading, setLoading] = useState(false)
  // Why the list could not be read, named in words only when it is shown, so a new interface language reaches it too.
  const [failure, setFailure] = useState<'http' | 'network' | 'timeout' | null>(null)
  const [open, setOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  const chosen = settings.llmModel === null ? defaultModel()
    : models?.find(model => model.id === settings.llmModel) ?? { id: settings.llmModel, name: settings.llmModel }
  // Only a whole list can say a model is gone; one cut short may hold it on a page not read.
  const gone = settings.llmModel !== null && models !== null && complete && !models.some(model => model.id === settings.llmModel)
  // Default is named in the interface language, so a new language lists it again.
  const matches = useMemo(() => matchModels(models ?? [], query), [models, query, locale])

  const load = async (): Promise<void> => {
    const current = request.current += 1
    setLoading(true)
    setFailure(null)
    const result = await onListModels().catch((): OpenRouterModelList => ({ ok: false, reason: 'network' }))
    if (current !== request.current) return
    setLoading(false)
    if (result.ok) { setModels(result.models); setComplete(result.complete) }
    else setFailure(result.reason)
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
      <label className="tt-field__label" htmlFor={`${id}-input`}><Trans>Cleanup model</Trans></label>
      <p className="tt-field__description tt-paragraph" id={descriptionId}><Trans>Default is the model Sotto tested for cleanup. If the chosen one fails or runs long, Mercury 2 steps in, or Default when Mercury 2 is the one chosen.</Trans></p>
      <div className="cleanup-model__control">
        <input ref={input} id={`${id}-input`} className="tt-input tt-focusable" type="text" role="combobox" autoComplete="off" spellCheck={false}
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={descriptionId}
          {...(open && matches[active] ? { 'aria-activedescendant': optionId(active) } : {})}
          value={open ? query : chosen.name}
          placeholder={open ? t`Search models` : undefined}
          onClick={() => { if (!open) show() }} onBlur={close}
          onChange={event => show(event.currentTarget.value)}
          onKeyDown={onKeyDown} />
        <button type="button" className="cleanup-model__refresh tt-focusable" aria-label={t`Refresh models`} title={t`Refresh models`} disabled={loading} onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
        {open ? <ul className="cleanup-model__list" data-above={above || undefined} id={listId} role="listbox" aria-label={t`Cleanup models`}>
          {matches.map((model, index) => <li key={model.id || 'default'} id={optionId(index)} role="option"
            aria-selected={model.id === chosen.id} data-active={index === active || undefined}
            onMouseDown={event => { event.preventDefault(); pick(model) }} onMouseMove={() => setActive(index)}>
            <span className="cleanup-model__name">{model.name}</span>
            {model.id ? <span className="cleanup-model__slug">{model.id}</span> : <span className="cleanup-model__slug"><Trans>Sotto’s choice</Trans></span>}
          </li>)}
          {matches.length === 0 ? <li className="cleanup-model__empty" role="presentation">{loading ? t`Loading models…` : models === null ? t`No models yet.` : t`No model matches.`}</li> : null}
        </ul> : null}
      </div>
    </div>
    {failure === null && !gone ? null : <p className="settings-remote-status settings-remote-status--error tt-paragraph" role="status">
      <CircleAlert size={16} aria-hidden="true" />{failure !== null ? failureCopy(failure) : t`OpenRouter no longer lists this model, so Mercury 2 cleans up instead. Choose another.`}
    </p>}
    <Field label={t({ message: 'Mode', comment: 'How OpenRouter picks a host for cleanup' })} description={t`How OpenRouter picks a host. Nitro takes the fastest and may bill at priority rates. Floor takes the cheapest and may run slower.`}>
      <SegmentedControl label={t({ message: 'Mode', comment: 'How OpenRouter picks a host for cleanup' })} value={settings.llmMode} onChange={value => void onSave({ llmMode: value as LlmMode })}
        options={[{ value: 'default', label: t({ message: 'Default', comment: 'The cleanup model or mode Sotto chooses itself' }) }, { value: 'nitro', label: 'Nitro' }, { value: 'floor', label: 'Floor' }]} />
    </Field>
  </>
}
