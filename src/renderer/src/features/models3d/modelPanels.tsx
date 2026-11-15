import { useLingui } from '@lingui/react/macro'
import { Box, TriangleAlert } from 'lucide-react'
import React, { lazy, Suspense, useState, type ReactNode } from 'react'
import { model3dFilesGone, type Model3dListed } from '../../../../shared/models3d'
import type { AgentState } from '../../../../shared/agents'
import { Button } from '../../components/Button'
import { makingWords, progressWords, Ring, stepWords, useStill } from '../../agents/modelParts'
import '../../agents/modelLine.css'
import './models3d.css'

/** three.js comes with the view, as in a thread, so the page's own code carries none of it. */
const ModelView = lazy(() => import('../../agents/ModelView'))

/**
 * What the 3D models page and Tools › 3D models show alike (the Meshy plan's ticket 5): the chosen 3D model's view,
 * its still picture in a tile, and what a record whose files are gone says.
 */

/** Whether the record's files are all gone from its folder. */
export const filesGone = (model: Model3dListed): boolean => model3dFilesGone(model)

/**
 * The chosen 3D model's view: the turnable view once done, the shape while the texture is painted, its step while
 * Meshy works, and what is left when its files are gone. It does not take focus; the arrow keys turn it once it has it.
 */
export function ModelStage({ model, reduced, onClose }: { readonly model: Model3dListed; readonly reduced: boolean; readonly onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const [unavailable, setUnavailable] = useState<string>()
  const still = useStill(model)
  const gone = filesGone(model)
  const part = model.state === 'done' && !gone ? 'model' : model.state === 'making' && model.stage === 'texture' && model.shape === true ? 'shape' : undefined
  if (part && unavailable !== model.id) {
    return <Suspense fallback={<div className="model-view"><div className="model-view__stage" aria-busy="true" /></div>}>
      <ModelView key={`${model.id}:${part}`} modelId={model.id} part={part} name={model.name} reduced={reduced} onClose={onClose} onUnavailable={() => setUnavailable(model.id)} focusOnOpen={false} />
    </Suspense>
  }
  if (part) return <div className="models-stage__over">{still ? <img src={still} alt={model.name} /> : <Box size={40} aria-hidden="true" />}<span>{t`Sotto cannot draw 3D models on this computer, so this is the still picture.`}</span></div>
  if (model.state === 'making') {
    const step = stepWords(model)
    return <div className="models-stage__over" role="status">
      <Ring percent={model.percent} spin={!reduced} size={40} />
      <b>{step}</b>
      {model.percent !== undefined ? <span>{progressWords(model.percent, model.secondsLeft)}</span> : null}
    </div>
  }
  return <div className="models-stage__over"><Box size={40} aria-hidden="true" /><b>{t`Its files are gone`}</b></div>
}

/** A tile's or a row's picture: the still once done, the ring while Meshy works, a cube when there is none. */
export function ModelPicture({ model, reduced, size }: { readonly model: Model3dListed; readonly reduced: boolean; readonly size: number }): ReactNode {
  const still = useStill(model)
  if (model.state === 'making') return <Ring percent={model.percent} spin={!reduced} size={size} />
  return still && !filesGone(model) ? <img src={still} alt="" /> : <Box size={size - 6} aria-hidden="true" />
}

/** What a tile or a row says under the name: the step and percent while Meshy works, or the day it was asked for. */
export function modelWhen(model: Model3dListed): string {
  return model.state === 'making' ? makingWords(model) : new Date(model.askedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The folder its files went to, as the user knows it from the thread: "models/". */
export function folderWords(model: Model3dListed, threadFolder: string): string {
  return model.folder ? `${model.folder}/` : threadFolder
}

/**
 * A record whose files are gone (ADR-0141): what happened, and Remove from 3D models, which removes the record only. Main
 * looks again first; files that are back keep it.
 */
export function GoneNote({ model, onRemoved, onKept }: { readonly model: Model3dListed; readonly onRemoved: () => void; readonly onKept: () => void }): ReactNode {
  const { t } = useLingui()
  const [busy, setBusy] = useState(false)
  const [kept, setKept] = useState(false)
  const name = model.name
  const where = folderWords(model, t`the thread’s folder`)
  const remove = (): void => {
    const plugins = window.sotto?.plugins
    if (!plugins?.removeModel3d || busy) return
    setBusy(true)
    void plugins.removeModel3d(model.id).then(removed => {
      if (removed) { onRemoved(); return }
      setKept(true)
      onKept()
    }, () => setKept(true)).finally(() => setBusy(false))
  }
  return <div className="models-note" role="group" aria-label={t`Its files are gone`}>
    <TriangleAlert size={16} aria-hidden="true" />
    <p><b>{t`Its files are gone.`}</b> {t({ message: `The ${name}’s files are no longer in ${where} in its thread’s folder: they were moved, renamed or deleted.`, comment: '{name} is the name of a 3D model; {where} is a folder, such as models/.' })}</p>
    <p className="models-note__more">{kept ? t`Its files are there again, so it stays.` : t`Removing it takes it off this list. It deletes no file.`}</p>
    <div className="models-note__actions"><Button variant="secondary" onClick={remove} disabled={busy}>{t`Remove from 3D models`}</Button></div>
  </div>
}

/** The thread a 3D model came from, and its project, as the window lists them now. */
export function threadOf(state: AgentState | null | undefined, threadId: string): { readonly title: string; readonly project?: string } | undefined {
  const thread = state?.host.threads.find(item => item.id === threadId)
  if (!thread) return undefined
  const project = state?.host.projects.find(item => item.id === thread.projectId)?.title
  return { title: thread.title, ...(project ? { project } : {}) }
}
