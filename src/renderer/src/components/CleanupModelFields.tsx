import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlert, RefreshCw } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import type { OpenRouterModelList } from '../../../shared/contracts'
import type { OwnServer, OwnServersBridge } from '../../../shared/ownModelServers'
import type { OwnCleanupChoice, OwnCleanupMeasured, OwnCleanupMeasureResult, OwnServerCleanupBridge } from '../../../shared/ownServerCleanup'
import type { AppSettings, LlmMode, SettingsPatch } from '../../../shared/settings'
import { Button } from './Button'
import { Field } from './Field'
import { SegmentedControl } from './SegmentedControl'

type Model = { readonly id: string; readonly name: string }
const DEFAULT: Model = { id: '', name: 'Default' }
/** A model on one of the user's own servers (ADR-0136); `id` keys the row and never meets an OpenRouter slug. */
type OwnModel = Model & { readonly own: OwnCleanupChoice; readonly serverName: string }
type Option = Model | OwnModel
const isOwn = (option: Option): option is OwnModel => 'own' in option
const ownKey = (choice: OwnCleanupChoice): string => `own\n${choice.server}\n${choice.model}`
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

/** The models of every server added without a key, by server, whose model, server name or model ID holds every word typed. */
export function matchOwnModels(servers: readonly OwnServer[], query: string): OwnModel[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  return servers.filter(server => !server.keyed).flatMap(server => server.models.map(model => ({
    id: ownKey({ server: server.id, model: model.id }), name: model.name, serverName: server.name, own: { server: server.id, model: model.id },
  }))).filter(model => {
    const text = `${model.name} ${model.own.model} ${model.serverName}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** What Measure is doing for the chosen own model, or what it last said went wrong. */
type Measuring = { readonly state: 'idle' } | { readonly state: 'measuring' } | { readonly state: 'refused'; readonly reason: Exclude<OwnCleanupMeasureResult['status'], 'measured'> }

/**
 * Settings → Cleanup's model and mode (Owl `cleanup-model`, ADR-0122). The model is a search box over OpenRouter's
 * text models, read when the box first opens; Default is Sotto's own choice. The mode is how OpenRouter picks a host.
 */
export function CleanupModelFields({ settings, onSave, onListModels, ownServers, ownCleanup }: {
  readonly settings: Pick<AppSettings, 'llmModel' | 'llmMode'> & Partial<Pick<AppSettings, 'llmOwnModel'>>
  readonly onSave: (patch: SettingsPatch) => Promise<boolean> | void
  readonly onListModels: () => Promise<OpenRouterModelList>
  /** Your own model servers and Measure (ADR-0136): both only while cleanup on the user's own servers runs. */
  readonly ownServers?: Pick<OwnServersBridge, 'list'> | undefined
  readonly ownCleanup?: OwnServerCleanupBridge | undefined
}): ReactNode {
  const { t, i18n } = useLingui()
  const id = useId()
  const ownOn = ownServers !== undefined && ownCleanup !== undefined
  const [servers, setServers] = useState<readonly OwnServer[] | null>(null)
  const [measured, setMeasured] = useState<readonly OwnCleanupMeasured[]>([])
  const [measuring, setMeasuring] = useState<Measuring>({ state: 'idle' })
  const measureRequest = useRef(0)
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

  // With the feature off the saved own model is kept and ignored, as main ignores it.
  const ownChoice = ownOn ? settings.llmOwnModel ?? null : null
  const ownServer = ownChoice === null ? undefined : servers?.find(server => server.id === ownChoice.server)
  const ownModel = ownChoice === null ? undefined : ownServer?.models.find(model => model.id === ownChoice.model)
  const chosen: Option = ownChoice !== null
    ? { id: ownKey(ownChoice), own: ownChoice, name: ownModel?.name ?? ownChoice.model, serverName: ownServer?.name ?? '' }
    : settings.llmModel === null ? DEFAULT
      : models?.find(model => model.id === settings.llmModel) ?? { id: settings.llmModel, name: settings.llmModel }
  // Only a whole list can say a model is gone; one cut short may hold it on a page not read.
  const gone = ownChoice === null && settings.llmModel !== null && models !== null && complete && !models.some(model => model.id === settings.llmModel)
  const ownGone = ownChoice !== null && servers !== null && ownModel === undefined
  const ownKeyed = ownServer?.keyed === true
  const tuning = ownChoice === null ? undefined : measured.find(item => item.server === ownChoice.server && item.model === ownChoice.model)?.tuning
  const keyedServers = servers?.some(server => server.keyed) === true
  const matches = useMemo((): Option[] => {
    const openRouter = matchModels(models ?? [], query)
    const own = ownOn ? matchOwnModels(servers ?? [], query) : []
    // Default stays first; the user's own servers come before OpenRouter's long list.
    return openRouter[0] === DEFAULT ? [DEFAULT, ...own, ...openRouter.slice(1)] : [...own, ...openRouter]
  }, [models, servers, ownOn, query])

  // The saved servers and measures are read from main, on this computer, never from a server.
  useEffect(() => {
    if (!ownServers || !ownCleanup) return
    let live = true
    void ownServers.list().then(list => { if (live) setServers(list) }, () => { if (live) setServers([]) })
    void ownCleanup.measured().then(list => { if (live) setMeasured(list) }, () => undefined)
    return () => { live = false }
  }, [ownOn, ownServers, ownCleanup])

  const measure = async (choice: OwnCleanupChoice): Promise<void> => {
    if (!ownCleanup) return
    const current = measureRequest.current += 1
    setMeasuring({ state: 'measuring' })
    const result = await ownCleanup.measure(choice).catch((): OwnCleanupMeasureResult => ({ status: 'failed' }))
    if (current !== measureRequest.current) return
    if (result.status === 'measured') {
      setMeasured(list => [...list.filter(item => item.server !== choice.server || item.model !== choice.model), { ...choice, tuning: result.tuning }])
      setMeasuring({ state: 'idle' })
    } else setMeasuring({ state: 'refused', reason: result.status })
  }

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
    if (ownServers && ownCleanup && servers === null) void ownServers.list().then(setServers, () => setServers([]))
    // Open upward when the window has more room above the box than below it, as at the minimum size.
    const box = input.current?.getBoundingClientRect()
    setAbove(box !== undefined && innerHeight - box.bottom < 240 && box.top > innerHeight - box.bottom)
    setOpen(true)
    if (models === null && !loading) void load()
  }
  const close = (): void => { setOpen(false); setQuery('') }
  const pick = (model: Option): void => {
    close()
    if (isOwn(model)) {
      // Picking a model on the user's own server measures it at once: that press is the only thing that asks the server.
      void onSave({ llmOwnModel: model.own })
      void measure(model.own)
      return
    }
    const next = model.id === '' ? null : model.id
    if (ownChoice !== null) {
      measureRequest.current += 1
      setMeasuring({ state: 'idle' })
      void onSave({ llmModel: next, llmOwnModel: null })
    } else if (next !== settings.llmModel) void onSave({ llmModel: next })
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
          {matches.map((model, index) => {
            const previous = matches[index - 1]
            const heading = ownOn && isOwn(model) && (previous === undefined || !isOwn(previous)) ? t`Your own servers`
              : ownOn && !isOwn(model) && model.id !== '' && previous !== undefined && isOwn(previous) ? 'OpenRouter' : null
            return <React.Fragment key={model.id || 'default'}>
              {heading === null ? null : <li className="cleanup-model__section" role="presentation">{heading}</li>}
              <li id={optionId(index)} role="option"
                aria-selected={model.id === chosen.id} data-active={index === active || undefined}
                onMouseDown={event => { event.preventDefault(); pick(model) }} onMouseMove={() => setActive(index)}>
                <span className="cleanup-model__name">{model.name}</span>
                {isOwn(model) ? <span className="cleanup-model__slug">{t`${model.own.model} on ${model.serverName}`}</span>
                  : model.id ? <span className="cleanup-model__slug">{model.id}</span> : <span className="cleanup-model__slug">Sotto’s choice</span>}
              </li>
            </React.Fragment>
          })}
          {ownOn && keyedServers ? <li className="cleanup-model__empty" role="presentation">{t`Servers added with a key are not listed. OpenCode keeps the key, not Sotto, so cleanup cannot use it.`}</li> : null}
          {matches.length === 0 ? <li className="cleanup-model__empty" role="presentation">{loading ? 'Loading models…' : models === null ? 'No models yet.' : 'No model matches.'}</li> : null}
        </ul> : null}
      </div>
    </div>
    {failure === null && !gone ? null : <p className="settings-remote-status settings-remote-status--error" role="status">
      <CircleAlert size={16} aria-hidden="true" />{failure ?? 'OpenRouter no longer lists this model, so Mercury 2 cleans up instead. Choose another.'}
    </p>}
    {ownChoice === null ? null : <OwnModelStatus
      words={ownGone ? { error: true, text: t`That server or model is no longer in Your own model servers, so Mercury 2 cleans up instead. Choose another.` }
        : ownKeyed ? { error: true, text: t`${chosen.name} is on a server added with a key, which OpenCode keeps and Sotto does not, so Mercury 2 cleans up instead. Choose another.` }
        : measuring.state === 'measuring' ? { error: false, text: t`Measuring ${chosen.name}. Sotto cleans up a built-in sample on the server, never your dictation.` }
        : measuring.state === 'refused' ? { error: true, text: measureRefusal(measuring.reason) }
        : tuning === undefined ? { error: false, text: t`Not measured yet. Measure again finds the fastest setting for this server.` }
        : tuning.status === 'none-passed' ? { error: true, text: t`No setting passed the test cleanups on ${chosen.name}, so Mercury 2 cleans up instead. Change the server, then measure again.` }
        : { error: false, text: fastestWords(tuning.thinking, tuning.ms) }}
      measureLabel={t`Measure again`}
      measuring={measuring.state === 'measuring'}
      canMeasure={!ownGone && !ownKeyed}
      onMeasure={() => { void measure(ownChoice) }} />}
    {ownChoice !== null ? null : <Field label="Mode" description="How OpenRouter picks a host. Nitro takes the fastest and may bill at priority rates. Floor takes the cheapest and may run slower.">
      <SegmentedControl setting="cleanup-mode" label="Mode" value={settings.llmMode} onChange={value => void onSave({ llmMode: value as LlmMode })}
        options={[{ value: 'default', label: 'Default' }, { value: 'nitro', label: 'Nitro' }, { value: 'floor', label: 'Floor' }]} />
    </Field>}
  </>

  function seconds(ms: number): string {
    return new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1_000)
  }
  function fastestWords(thinking: 'plain' | 'off' | 'least', ms: number): string {
    const time = seconds(ms)
    switch (thinking) {
      case 'plain': return t`Fastest: the model’s own thinking, ${time} s.`
      case 'off': return t`Fastest: thinking off, ${time} s.`
      case 'least': return t`Fastest: least thinking, ${time} s.`
    }
  }
  function measureRefusal(reason: Exclude<OwnCleanupMeasureResult['status'], 'measured'>): string {
    const server = ownServer?.name ?? ''
    const model = chosen.name
    switch (reason) {
      case 'unreachable': return t`Nothing answered at ${server}. Nothing was changed. Check the server is on and this computer can reach it, then measure again.`
      case 'keyed': return t`${model} is on a server added with a key, which OpenCode keeps and Sotto does not, so Mercury 2 cleans up instead. Choose another.`
      case 'not-found': return t`That server or model is no longer in Your own model servers, so Mercury 2 cleans up instead. Choose another.`
      case 'failed': return t`Sotto could not finish measuring. Nothing was changed. Measure again.`
    }
  }
}

/** What Measure found or is doing for the chosen own model, with Measure again beside it (ADR-0136). */
function OwnModelStatus({ words, measureLabel, measuring, canMeasure, onMeasure }: {
  readonly words: { readonly error: boolean; readonly text: string }
  readonly measureLabel: string
  readonly measuring: boolean
  readonly canMeasure: boolean
  readonly onMeasure: () => void
}): ReactNode {
  return <div className="cleanup-model__measure">
    <p className={`settings-remote-status tt-paragraph${words.error ? ' settings-remote-status--error' : ''}`} role="status">
      {words.error ? <CircleAlert size={16} aria-hidden="true" /> : null}{words.text}
    </p>
    {canMeasure ? <Button variant="secondary" disabled={measuring} onClick={onMeasure}>{measureLabel}</Button> : null}
  </div>
}
