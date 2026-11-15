import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { Box, ChevronDown, CircleAlert } from 'lucide-react'
import React, { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Model3dFailure, Model3dView } from '../../../shared/models3d'
import { useOwlFeature } from '../state/owlFeature'
import { useReducedMotion } from '../state/reducedMotion'
import './modelLine.css'

/** three.js comes with the view, so a thread that never opens one never loads it. */
const ModelView = lazy(() => import('./ModelView'))

/**
 * A 3D model Meshy made for a thread, in that thread (ADR-0141; the Meshy plan's ticket 4, Zach's variant A): a quiet
 * line under the agent's turn with the still picture, the name and what it cost, which opens in place into a view that
 * turns. While Meshy works the line says which step it is on, Meshy's percent and the time left; once done it stays
 * closed until pressed; when it was not made it says what happened, what was counted and that nothing was saved.
 * Part of the `plugins` Owl feature: with it off the line is not there at all.
 */
export function ModelLine({ modelId, name }: { readonly modelId: string; readonly name: string }): ReactNode {
  const on = useOwlFeature('plugins')
  const view = useModelView(modelId, on)
  const reduced = useReducedMotion(on)
  return on ? <Line modelId={modelId} name={name} view={view} reduced={reduced} /> : null
}

/** A 3D model's view as main last sent it: undefined until it answers, null when it holds no such 3D model. */
function useModelView(id: string, on: boolean): Model3dView | null | undefined {
  const [view, setView] = useState<Model3dView | null | undefined>(undefined)
  useEffect(() => {
    if (!on) return undefined
    const plugins = window.sotto?.plugins
    if (!plugins?.model3d) { setView(null); return undefined }
    let live = true
    let heard = false
    const stop = plugins.onModel3dChanged?.(next => { if (live && next.id === id) { heard = true; setView(next) } })
    // A change heard while the read was on its way is newer than the read.
    plugins.model3d(id).then(found => { if (live && !heard) setView(found) }, () => { if (live && !heard) setView(null) })
    return () => { live = false; stop?.() }
  }, [id, on])
  return view
}

/** The still picture, read once the 3D model is done, as an address the window may show. */
function useStill(view: Model3dView | null | undefined): string | undefined {
  const [still, setStill] = useState<string>()
  const wanted = view?.state === 'done' && view.still ? `${view.id}/${view.still}` : undefined
  useEffect(() => {
    if (!wanted || !view) { setStill(undefined); return undefined }
    let live = true
    const type = /\.jpe?g$/iu.test(view.still ?? '') ? 'image/jpeg' : /\.webp$/iu.test(view.still ?? '') ? 'image/webp' : 'image/png'
    void window.sotto?.plugins?.model3dBytes({ id: view.id, part: 'still' }).then(bytes => { if (live) setStill(bytes ? `data:${type};base64,${base64(bytes)}` : undefined) }, () => undefined)
    return () => { live = false }
    // The picture is read again only when the 3D model or its picture changes, not on each of Meshy's reads.
  }, [wanted])
  return still
}

function Line({ modelId, name, view, reduced }: { readonly modelId: string; readonly name: string; readonly view: Model3dView | null | undefined; readonly reduced: boolean }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [webgl, setWebgl] = useState(true)
  const toggle = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const still = useStill(view)
  const shown = view?.name ?? name
  const close = useCallback(() => { setOpen(false); toggle.current?.focus() }, [])
  const unavailable = useCallback(() => setWebgl(false), [])

  const making = view?.state === 'making'
  const ended = view?.state === 'failed' || view?.state === 'lost'
  const done = view?.state === 'done'
  const shape = making && view.stage === 'texture' && view.shape === true
  // What a press opens: the model once done, the shape while the texture is painted, and what happened when it ended.
  const opens: 'model' | 'shape' | 'ended' | undefined = done ? 'model' : shape ? 'shape' : ended ? 'ended' : undefined
  // The shape goes while the files are saved, and an open shape closes with it; a finished 3D model starts closed.
  useEffect(() => { if (!opens) setOpen(false) }, [opens])
  const label = opens === 'model' ? (open ? t`Hide the model` : t`Show the model`)
    : opens === 'shape' ? (open ? t`Hide the shape` : t`Show the shape`)
      : open ? t`Hide what happened` : t`Show what happened`

  const step = making ? stepWords(view) : undefined
  const sub = view === undefined ? t`3D model`
    : view === null ? t`Sotto no longer holds this 3D model.`
      : making ? [step, view.percent !== undefined ? progressWords(view.percent, view.secondsLeft) : undefined].filter(Boolean).join(' · ')
        : done ? [t`3D model`, creditsWords(view.credits), plural(view.files.length, { one: '# file', other: '# files' })].join(' · ')
          : endedLine(view.failure, view.credits)

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  return <div className="model-line" role="group" aria-label={t({ message: `3D model: ${shown}`, comment: '{shown} is the name of a 3D model, such as Oak barrel.' })} data-open={open && opens ? 'true' : 'false'} onKeyDown={keyDown}>
    <div className="model-line__row">
      <span className="model-line__thumb" aria-hidden="true">
        {done && still ? <img src={still} alt="" /> : making ? <Ring percent={view.percent} spin={!reduced} /> : <Box size={22} />}
      </span>
      <span className="model-line__text">
        <b className="model-line__name">{shown}</b>
        <span className={ended ? 'model-line__sub model-line__sub--ended' : 'model-line__sub'}>{sub}</span>
        {making && view.percent !== undefined && <span className="model-line__progress" role="progressbar" aria-label={step}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}><i style={{ width: `${view.percent}%` }} /></span>}
      </span>
      {opens && <button ref={toggle} type="button" className="model-line__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        <span>{label}</span><ChevronDown size={16} aria-hidden="true" />
      </button>}
    </div>
    {opens && <div className="model-line__body" id={bodyId} hidden={!open}>
      {open && view && (opens === 'ended' ? <Ended view={view} /> : <>
        {webgl
          ? <Suspense fallback={<div className="model-view"><div className="model-view__stage" aria-busy="true" /></div>}>
            <ModelView modelId={modelId} part={opens} name={shown} reduced={reduced} onClose={close} onUnavailable={unavailable} />
          </Suspense>
          : <div className="model-line__still">{still ? <img src={still} alt={shown} /> : <Box size={48} aria-hidden="true" />}<span>{t`Sotto cannot draw 3D models on this computer, so this is the still picture.`}</span></div>}
        <Facts view={view} />
      </>)}
    </div>}
  </div>
}

/** The facts under the view: what it was made from and cost, and a chip for each file; or, for the shape, what follows. */
function Facts({ view }: { readonly view: Model3dView }): ReactNode {
  const { t } = useLingui()
  if (view.state === 'making') {
    const where = view.folder ? `${view.folder}/` : t`the thread’s folder`
    return <div className="model-line__foot"><p className="model-line__facts">{t({ message: `The shape is ready to turn. The texture follows, then the files go to ${where}.`, comment: '{where} is a folder inside the thread\'s folder, such as models/.' })}</p></div>
  }
  const from = view.source === 'photo' ? t`Made from a photo` : t`Made from words`
  return <div className="model-line__foot">
    <p className="model-line__facts">{from} · <b>{creditsWords(view.credits)}</b></p>
    <ul className="model-line__files" aria-label={t`Files`}>
      {view.files.map(file => <li key={file.name} className="model-line__file" title={file.name}>
        <span className="model-line__extension">{extensionOf(file.name)}</span>{file.bytes !== undefined ? sizeWords(file.bytes) : t`not found`}
      </li>)}
    </ul>
  </div>
}

/** What happened to a 3D model that was not made, for the user, from what the tool tells its agent. */
function Ended({ view }: { readonly view: Model3dView }): ReactNode {
  const { t } = useLingui()
  const name = view.name
  const charged = view.credits === 0 ? t`Nothing was charged.` : plural(view.credits, { one: '# credit was counted against this month’s limit.', other: '# credits were counted against this month’s limit.' })
  const happened = ((failure: Model3dFailure | undefined): string => {
    switch (failure) {
      case 'refused': return t`Meshy did not accept the Meshy account’s key. Replace it in Settings > Plugins.`
      case 'no-credits': return t`The Meshy account has no credits left, or its plan has no API access.`
      case 'rejected': return view.source === 'photo' ? t`Meshy would not make a 3D model from this photo.` : t`Meshy would not make a 3D model from these words.`
      case 'failed': return t`Meshy could not finish it, and gave back the credits of what it could not make.`
      case 'too-large': return t`A file Meshy made was larger than Sotto takes.`
      case 'folder': return t`The folder would not take the files: it is not inside the thread’s folder, or could not be written.`
      case 'no-account': return t`The Meshy account was removed before the 3D model was made.`
      case 'locked': return t`Sotto could not read the Meshy account’s key, because this computer’s credential store was locked.`
      case 'expired': return t`Meshy no longer has the 3D model, so its files could not be fetched.`
      default: return t`Sotto could not tell whether Meshy took the request.`
    }
  })(view.failure)
  return <div className="model-line__problem">
    <CircleAlert size={16} aria-hidden="true" />
    <p><b>{t({ message: `The ${name} was not made.`, comment: '{name} is the name of a 3D model, such as Oak barrel.' })}</b></p>
    <p>{happened} {t`Sotto saved no files.`} {charged}</p>
  </div>
}

/** A ring that fills with Meshy's percent, or turns while there is none yet. */
function Ring({ percent, spin }: { readonly percent: number | undefined; readonly spin: boolean }): ReactNode {
  const filled = percent === undefined ? 30 : percent
  return <svg className={percent === undefined && spin ? 'model-line__ring model-line__ring--spin' : 'model-line__ring'} viewBox="0 0 24 24" width="26" height="26">
    <circle className="model-line__ring-track" cx="12" cy="12" r="9" />
    <circle className="model-line__ring-fill" cx="12" cy="12" r="9" strokeDasharray={`${(filled / 100 * 56.5).toFixed(1)} 56.5`} />
  </svg>
}

/** The step Meshy is on: two from words, one from a photo, then saving the files. */
function stepWords(view: Model3dView): string {
  if (view.stage === 'files') return t`Saving the files`
  if (view.source === 'photo') return t`Making the 3D model`
  return view.stage === 'texture' ? t`Step 2 of 2: painting the texture` : t`Step 1 of 2: making the shape`
}

/** Meshy's percent and, once there is a rate to go by, about how long is left: "68%, about 40 seconds left". */
function progressWords(percent: number, secondsLeft: number | undefined): string {
  if (secondsLeft === undefined) return t({ message: `${percent}%`, comment: '{percent} is Meshy\'s percent for the step it is on.' })
  // Seconds to the nearest five under three quarters of a minute, then a minute, then whole minutes.
  const left = secondsLeft < 45 ? t({ message: `about ${Math.max(5, Math.round(secondsLeft / 5) * 5)} seconds left`, comment: 'A number of seconds, at least 5.' })
    : secondsLeft < 90 ? t`about a minute left`
      : t({ message: `about ${Math.round(secondsLeft / 60)} minutes left`, comment: 'A number of minutes, at least 2.' })
  return t({ message: `${percent}%, ${left}`, comment: '{percent} is Meshy\'s percent; {left} says about how long is left, such as "about 40 seconds left".' })
}

const creditsWords = (credits: number): string => plural(credits, { one: '# credit', other: '# credits' })

/** The line of a 3D model that was not made: what happened, that nothing was saved, and what was counted. */
function endedLine(failure: Model3dFailure | undefined, credits: number): string {
  const what = ((): string => {
    switch (failure) {
      case 'refused': return t`Meshy did not accept the key`
      case 'no-credits': return t`The Meshy account has no credits left`
      case 'rejected': return t`Meshy would not make it`
      case 'failed': return t`Could not finish`
      case 'too-large': return t`A file was too large to save`
      case 'folder': return t`The folder would not take the files`
      case 'no-account': return t`The Meshy account was removed`
      case 'locked': return t`The key could not be read`
      case 'expired': return t`Meshy no longer has it`
      default: return t`Sotto lost track of it`
    }
  })()
  const counted = credits === 0 ? t`nothing charged` : plural(credits, { one: '# credit counted', other: '# credits counted' })
  return [what, t`nothing saved`, counted].join(' · ')
}

/** A file's kind by its extension, as its chip shows it: ".glb". */
const extensionOf = (name: string): string => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : name }

/** A file's size in megabytes to one place, or in kilobytes under a tenth of one. */
function sizeWords(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 0.1) { const shown = megabytes.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }); return t`${shown} MB` }
  const kilobytes = Math.max(1, Math.round(bytes / 1024)).toLocaleString()
  return t`${kilobytes} KB`
}

/** Bytes as base64, a piece at a time so a large picture never overflows the call. */
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.byteLength; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}
