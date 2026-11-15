import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { File, FolderOutput, Search, X } from 'lucide-react'
import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Model3dListed } from '../../../../shared/models3d'
import type { SottoPlatform } from '../../../../shared/platform'
import { useOptionalAgents } from '../../agents/AgentContext'
import { creditsWords, progressWords, sizeWords, stepWords } from '../../agents/modelParts'
import { Button } from '../../components/Button'
import { useOptionalApp } from '../../state/AppContext'
import { useOwlFeature } from '../../state/owlFeature'
import { useReducedMotion } from '../../state/reducedMotion'
import { revealLabel } from '../../tools/FilePreview'
import { filesGone, folderWords, GoneNote, ModelPicture, ModelStage, modelWhen, threadOf, tileWords } from './modelPanels'
import { modelMatches, useModelChoice, useModels3d, useMonthCredits } from './models3dList'

/**
 * The 3D models page (ADR-0141; the Meshy plan's ticket 5, Zach's variant C): every 3D model this computer's threads
 * made or are making, newest first. One large view of the chosen one with its details beside it, Go to thread and
 * Show in File Explorer, its facts and its files; a filmstrip of every 3D model below, which the arrow keys move
 * along. A record whose files are gone says so and offers to remove itself, never a file. Failed and lost 3D models
 * stay as their line in their thread (Zach's pick on November 15, 2026). Part of the `plugins` Owl feature.
 */
export function ModelsPage({ platform }: { readonly platform: SottoPlatform }): ReactNode {
  const { t } = useLingui()
  const on = useOwlFeature('plugins')
  const list = useModels3d(on, undefined, { watchFiles: true })
  const { models, reload } = list
  const reduced = useReducedMotion(on)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // This month's credits are read again as a 3D model comes, goes or costs more.
  const credits = useMonthCredits(on, models?.map(model => `${model.id}:${model.credits}`).join(',') ?? '')
  const shown = useMemo(() => models?.filter(model => modelMatches(model, query)) ?? [], [models, query])
  const { selected, choose, removed } = useModelChoice(list, shown)
  if (!on) return null

  const threads = new Set(models?.map(model => model.threadId)).size
  const summary = models && models.length > 0
    ? [`${plural(models.length, { one: '# 3D model', other: '# 3D models' })} ${plural(threads, { one: 'from # thread', other: 'from # threads' })}`,
      ...(credits !== undefined ? [plural(credits, { one: '# credit this month', other: '# credits this month' })] : [])].join(' · ')
    : undefined
  const focusTile = (id: string | undefined): void => {
    if (id) strip.current?.querySelector<HTMLElement>(`[data-model="${CSS.escape(id)}"]`)?.focus()
  }

  let body: ReactNode = null
  if (models !== undefined && models.length === 0) {
    body = <div className="models-page__empty"><div><b>{t`No 3D models yet`}</b><p>{t`When a thread makes one with Meshy, it shows here, with its files and the thread it came from.`}</p></div></div>
  } else if (models !== undefined && !selected) {
    body = <div className="models-page__empty" role="status"><div><b>{t({ message: `No 3D models match “${query}”`, comment: '{query} is what was typed in the search box.' })}</b></div></div>
  } else if (selected) {
    body = <>
      <div className="models-page__stage">
        <div className="models-page__view">
          <ModelStage model={selected} reduced={reduced} onClose={() => focusTile(selected.id)} />
        </div>
        <ModelDetails model={selected} platform={platform}
          onRemoved={id => { const next = removed(id); if (next) requestAnimationFrame(() => focusTile(next)) }}
          onKept={reload} />
      </div>
      <Filmstrip ref={strip} models={shown} selected={selected.id} reduced={reduced} onChoose={choose} />
    </>
  }

  return <section className="models-page" aria-labelledby={titleId}><div className="models-page__scroll"><div className="models-page__inner">
    <header className="models-page__head">
      <h1 id={titleId}>{t({ message: '3D models', comment: 'The 3D models page: every 3D model Meshy made for a thread.' })}</h1>
      {summary ? <p className="models-page__sub">{summary}</p> : null}
      {models && models.length > 0 ? <label className="models-search">
        <span className="tt-visually-hidden">{t`Search 3D models`}</span>
        <Search size={15} aria-hidden="true" />
        <input ref={search} className="models-search__input tt-focusable" type="search" value={query} placeholder={t`Search 3D models`}
          onChange={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Escape' && query !== '') { event.preventDefault(); event.stopPropagation(); setQuery('') } }} />
        {query !== '' ? <button type="button" className="models-search__clear tt-focusable" aria-label={t`Clear search`} title={t`Clear search`}
          onClick={() => { setQuery(''); search.current?.focus() }}><X size={14} aria-hidden="true" /></button> : null}
      </label> : null}
    </header>
    {body}
  </div></div></section>
}

/** The details beside the view: the name and kind, Go to thread and Show in File Explorer, the facts and the files. */
function ModelDetails({ model, platform, onRemoved, onKept }: { readonly model: Model3dListed; readonly platform: SottoPlatform; readonly onRemoved: (id: string) => void; readonly onKept: () => void }): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const [status, setStatus] = useState('')
  useEffect(() => { setStatus('') }, [model.id])
  // A reveal answered after another 3D model was chosen says nothing under that one.
  const shownId = useRef(model.id)
  shownId.current = model.id
  const thread = threadOf(agents?.state, model.threadId)
  const reveal = revealLabel(platform)
  const gone = filesGone(model)
  const done = model.state === 'done'
  const show = (file?: string): void => {
    const asked = model.id
    const answer = (shown: boolean): void => { if (shownId.current === asked) setStatus(shown ? '' : t`Sotto could not find that file. It may have been moved or deleted.`) }
    void window.sotto?.plugins?.revealModel3d({ id: asked, ...(file !== undefined ? { file } : {}) }).then(answer, () => answer(false))
  }
  const openThread = (): void => {
    if (!agents || !thread) return
    void agents.command({ type: 'select-thread', threadId: thread.id }).finally(() => app?.actions.navigate('threads'))
  }
  const kind = model.source === 'photo' ? t`3D model · Meshy · made from a photo` : t`3D model · Meshy · made from words`
  const made = new Date(model.askedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const where = folderWords(model, t`the thread’s folder`)
  const name = model.name
  const cost = creditsWords(model.credits)

  return <aside className="models-page__details" aria-label={t({ message: `About the ${name}`, comment: '{name} is the name of a 3D model, such as Oak barrel.' })}>
    <h2>{model.name}</h2>
    <p className="models-page__kind">{kind}</p>
    <div className="models-page__actions">
      {thread ? <Button variant="primary" onClick={openThread}>{t`Go to thread`}</Button> : null}
      {done && !gone ? <Button variant="secondary" onClick={() => show()}>{reveal}</Button> : null}
    </div>
    <dl className="models-facts">
      <dt>{t({ message: 'Thread', comment: 'A 3D model\'s fact: the thread that made it.' })}</dt>
      <dd>{thread ? <>{thread.title}{thread.project ? <span className="models-facts__quiet"> · {thread.project}</span> : null}</> : t`A thread that is no longer listed`}</dd>
      <dt>{t({ message: 'Made', comment: 'A 3D model\'s fact: when it was made.' })}</dt>
      <dd>{made}</dd>
      {model.words !== undefined ? <><dt>{t`Words sent`}</dt><dd>{model.words}</dd></> : null}
      {model.photo !== undefined ? <><dt>{t`Photo sent`}</dt><dd className="models-facts__file">{model.photo}</dd></> : null}
      <dt>{t({ message: 'Cost', comment: 'A 3D model\'s fact: the credits it cost.' })}</dt>
      <dd>{model.state === 'making' ? t({ message: `${cost}, counted while it is made`, comment: '{cost} is what a 3D model being made has cost so far, such as "20 credits".' }) : cost}</dd>
    </dl>
    {model.state === 'making' ? <div className="models-making">
      <p className="models-making__words">{[stepWords(model), model.percent !== undefined ? progressWords(model.percent, model.secondsLeft) : undefined].filter(Boolean).join(' · ')}</p>
      {model.percent !== undefined ? <span className="model-line__progress" role="progressbar" aria-label={stepWords(model)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={model.percent}><i style={{ width: `${model.percent}%` }} /></span> : null}
      <p className="models-making__words">{t({ message: `The files go to ${where} in the thread’s folder when it is done.`, comment: '{where} is a folder, such as models/.' })}</p>
    </div> : gone ? <GoneNote key={model.id} model={model} onRemoved={onRemoved} onKept={onKept} /> : <>
      <h3 className="models-files__head">{t`Files`}</h3>
      <ul className="models-files" aria-label={t`Files`}>
        {model.files.map(file => <li key={file.name}>
          <File size={14} aria-hidden="true" />
          <span className="models-files__name" title={`${model.folder ? `${model.folder}/` : ''}${file.name}`}>{model.folder ? `${model.folder}/` : ''}{file.name}</span>
          <span className="models-files__size">{file.bytes !== undefined ? sizeWords(file.bytes) : t`not found`}</span>
          {file.bytes !== undefined ? <button type="button" className="models-icon tt-focusable" onClick={() => show(file.name)}
            aria-label={revealFile(reveal, file.name)} title={revealFile(reveal, file.name)}><FolderOutput size={15} aria-hidden="true" /></button> : null}
        </li>)}
      </ul>
    </>}
    <p className="models-page__status" role="status" aria-live="polite">{status}</p>
  </aside>
}

/** A file's reveal button's name: "Show in File Explorer: Oak barrel.glb". */
function revealFile(reveal: string, file: string): string {
  return t({ message: `${reveal}: ${file}`, comment: '{reveal} is "Show in File Explorer" or the like; {file} is a file\'s name.' })
}

/**
 * Every 3D model shown, newest first, as tiles below the view. One Tab stop: Left and Right move along it and choose
 * as they go, Home and End go to either end.
 */
const Filmstrip = React.forwardRef<HTMLDivElement, { readonly models: readonly Model3dListed[]; readonly selected: string; readonly reduced: boolean; readonly onChoose: (id: string) => void }>(
  function Filmstrip({ models, selected, reduced, onChoose }, ref): ReactNode {
    const { t } = useLingui()
    const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      const at = models.findIndex(model => model.id === selected)
      const next = event.key === 'ArrowRight' ? Math.min(models.length - 1, at + 1) : event.key === 'ArrowLeft' ? Math.max(0, at - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? models.length - 1 : null
      if (next === null) return
      event.preventDefault()
      event.stopPropagation()
      const id = models[next]!.id
      onChoose(id)
      const strip = event.currentTarget
      // Focus brings the tile into view along the strip.
      requestAnimationFrame(() => { strip.querySelector<HTMLElement>(`[data-model="${CSS.escape(id)}"]`)?.focus() })
    }
    return <div ref={ref} className="models-strip" role="listbox" aria-orientation="horizontal" aria-label={t`Every 3D model`} onKeyDown={keyDown}>
      {models.map(model => {
        const gone = filesGone(model)
        return <div key={model.id} role="option" className="models-tile tt-focusable" data-model={model.id} aria-selected={model.id === selected} tabIndex={model.id === selected ? 0 : -1}
          onClick={() => onChoose(model.id)} aria-label={[model.name, modelWhen(model), ...(gone ? [t`Its files are gone`] : [])].join(', ')}>
          <span className="models-tile__pic" aria-hidden="true">{gone ? <span className="models-tile__gone">{t`Files gone`}</span> : <ModelPicture model={model} reduced={reduced} size={30} />}</span>
          <b className="models-tile__name" aria-hidden="true">{model.name}</b>
          <span className="models-tile__sub" aria-hidden="true">{tileWords(model)}</span>
        </div>
      })}
    </div>
  })
