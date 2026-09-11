import React, { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import type { AgentModel } from '../../../shared/agents'
import './modelPicker.css'

export function newestModelsFirst(models: readonly AgentModel[]): AgentModel[] {
  const version = (model: AgentModel): number[] => (model.name.match(/\d+(?:\.\d+)*/)?.[0] ?? model.id.match(/\d+(?:\.\d+)*/)?.[0] ?? '').split('.').map(Number)
  return [...models].sort((left, right) => {
    const leftVersion = version(left)
    const rightVersion = version(right)
    for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
      const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0)
      if (difference) return difference
    }
    return 0
  })
}

export function ModelPicker({ models, modelId, disabled, onChange }: {
  readonly models: AgentModel[]; readonly modelId: string; readonly disabled: boolean; readonly onChange: (id: string) => void
}): ReactNode {
  const current = models.find(model => model.id === modelId)
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dialogId = useId()
  const groups = useMemo(() => {
    const result = new Map<string, AgentModel[]>()
    for (const model of models) result.set(model.provider, [...(result.get(model.provider) ?? []), model])
    return [...result].map(([name, items]) => ({ name, models: newestModelsFirst(items) }))
  }, [models])
  const selectedProvider = groups.find(group => group.name === provider) ?? groups.find(group => group.name === current?.provider) ?? groups[0]
  const filtered = selectedProvider?.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase())) ?? []
  useLayoutEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    element.showModal?.()
    if (!element.open) element.setAttribute('open', '')
    const anchor = trigger.current?.getBoundingClientRect()
    if (anchor) {
      const width = element.offsetWidth || 540
      const height = element.offsetHeight || 390
      const below = innerHeight - anchor.bottom - 16
      const top = below >= height ? anchor.bottom + 8 : anchor.top - height - 8
      element.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - width - 16))}px`
      element.style.top = `${Math.max(16, Math.min(top, innerHeight - height - 16))}px`
    }
    search.current?.focus()
    return () => { element.close?.(); trigger.current?.focus() }
  }, [open])
  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-picker__trigger" role="combobox" aria-label="Thread model" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      title={current?.name ?? (modelId || 'Choose a model')} disabled={disabled} onClick={() => { setProvider(current?.provider ?? groups[0]?.name ?? ''); setQuery(''); setOpen(true) }}>
      <span>{current?.name ?? (modelId || 'Choose a model')}</span><ChevronDown size={14} />
    </button>
    {open && <dialog ref={dialog} id={dialogId} className="model-picker__dialog" aria-label="Choose model"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}
      onClick={event => { if (event.target === event.currentTarget) setOpen(false); event.stopPropagation() }}>
      <header className="model-picker__search"><Search size={16} /><input ref={search} aria-label="Search models" placeholder="Search models..." value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') event.preventDefault()
          if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
        }} />
        <button type="button" aria-label="Close model picker" title="Close model picker" onClick={() => setOpen(false)}><X size={16} /></button>
      </header>
      <div className="model-picker__body"><nav aria-label="Model providers">{groups.map(group => <button type="button" key={group.name} aria-label={group.name} aria-pressed={selectedProvider?.name === group.name} onClick={() => setProvider(group.name)}><span>{group.name}</span><small aria-hidden="true">{group.models.length}</small></button>)}</nav>
        <section><header><strong>{selectedProvider?.name ?? 'Models'}</strong><span>Newest first</span></header>
          <div ref={list} role="listbox" aria-label={`${selectedProvider?.name ?? ''} models`} className="model-picker__models" onKeyDown={event => {
            const options = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            const index = options.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'ArrowDown' ? (index + 1) % options.length : event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
            if (next >= 0) { event.preventDefault(); options[next]?.focus() }
          }}>{filtered.map(model => <button type="button" role="option" key={model.id} aria-selected={model.id === modelId} disabled={disabled || !model.ready}
            onClick={() => { onChange(model.id); setOpen(false) }}><span>{model.name}{!model.ready && <small>Unavailable</small>}</span>{model.id === modelId && <Check size={15} />}</button>)}
            {!filtered.length && <p className="model-picker__empty">No matching models.</p>}
          </div>
        </section>
      </div>
    </dialog>}
  </div>
}
