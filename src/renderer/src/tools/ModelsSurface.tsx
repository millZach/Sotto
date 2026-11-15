import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import React, { useRef, type ReactNode } from 'react'
import type { Model3dListed } from '../../../shared/models3d'
import { creditsWords, extensionOf, sizeWords } from '../agents/modelParts'
import { filesGone, GoneNote, ModelPicture, ModelStage, modelWhen } from '../features/models3d/modelPanels'
import { useModelChoice, type Models3dList } from '../features/models3d/models3dList'
import { useReducedMotion } from '../state/reducedMotion'
import { ToolsChrome } from './ToolsChrome'

/**
 * Tools › 3D models (ADR-0141; the Meshy plan's ticket 5): the open thread's 3D models, made or being made. The chosen
 * one's view on top with its name, its facts and a chip for each file, which opens that file in Files; below it, every
 * 3D model the thread made, newest first. A record whose files are gone says so, as the 3D models page does. Part of the
 * `plugins` Owl feature: the panel lists the surface only while it is on.
 */
export function ModelsSurface({ list, onShowFile }: {
  /** The thread's 3D models, read by the panel, which also lights the rail's dot from them. */
  readonly list: Models3dList
  /** Opens one of the files in Files, by its path inside the thread's folder. */
  readonly onShowFile: (path: string) => void
}): ReactNode {
  const { t } = useLingui()
  const reduced = useReducedMotion()
  const rows = useRef<HTMLUListElement>(null)
  const models = list.models
  const { selected: chosen, choose, removed } = useModelChoice(list, models ?? [])
  const title = t({ message: '3D models', comment: 'The Tools surface that shows the 3D models a thread made.' })
  if (models === undefined) return <ToolsChrome title={title} />
  if (models.length === 0) return <><ToolsChrome title={title} /><div className="files-problem files-problem--root" role="status">
    <strong>{t`No 3D models in this thread yet`}</strong><p className="tt-paragraph">{t`When the thread makes one with Meshy, it shows here with its files.`}</p></div></>

  const selected = chosen ?? models[0]!
  const accounts = [...new Set(models.map(model => model.account).filter(Boolean))]
  const spent = models.reduce((sum, model) => sum + model.credits, 0)
  const credits = plural(spent, { one: '# credit in this thread', other: '# credits in this thread' })
  const name = accounts[0] ?? '', names = accounts.join(', ')
  const account = accounts.length === 0 ? credits
    : accounts.length === 1 ? t({ message: `Made with the Meshy account ${name} · ${credits}`, comment: '{name} is the name the user gave a Meshy account, such as Studio; {credits} is "60 credits in this thread".' })
      : t({ message: `Made with the Meshy accounts ${names} · ${credits}`, comment: '{names} lists the names the user gave Meshy accounts; {credits} is "60 credits in this thread".' })
  const focusRow = (id: string | undefined): void => { if (id) rows.current?.querySelector<HTMLElement>(`[data-model="${CSS.escape(id)}"]`)?.focus() }

  return <>
    <ToolsChrome title={title} />
    <div className="models-tool">
      <p className="models-tool__account">{account}</p>
      <section className="models-tool__card" aria-label={selected.name}>
        <div className="models-tool__view"><ModelStage model={selected} reduced={reduced} onClose={() => focusRow(selected.id)} /></div>
        <div className="models-tool__about">
          <h3>{selected.name}</h3>
          <ChosenFacts model={selected} />
          {filesGone(selected) ? <GoneNote key={selected.id} model={selected} onRemoved={id => { const next = removed(id); if (next) requestAnimationFrame(() => focusRow(next)) }} onKept={list.reload} />
            : selected.state === 'done' ? <ul className="model-line__files models-tool__chips" aria-label={t`Files`}>
              {selected.files.map(file => <li key={file.name}>
                <FileChip name={file.name} bytes={file.bytes} onShow={() => onShowFile(`${selected.folder ? `${selected.folder}/` : ''}${file.name}`)} />
              </li>)}
            </ul> : null}
        </div>
      </section>
      <h3 className="models-tool__list-head"><span>{t`Made in this thread`}</span>{' '}<span className="models-tool__count">{models.length}</span></h3>
      <ul ref={rows} className="models-tool__rows" aria-label={t`Made in this thread`}>
        {models.map(model => <li key={model.id}>
          <button type="button" className="models-tool__row tt-focusable" data-model={model.id} aria-current={model.id === selected.id ? 'true' : undefined} onClick={() => choose(model.id)}>
            <span className="models-tool__pic" aria-hidden="true"><ModelPicture model={model} reduced={reduced} size={26} /></span>
            <span className="models-tool__text"><b>{model.name}</b><span>{rowWords(model)}</span></span>
            <span className="models-tool__credits">{creditsWords(model.credits)}</span>
          </button>
        </li>)}
      </ul>
    </div>
  </>
}

/** What the chosen 3D model was made from and cost. */
function ChosenFacts({ model }: { readonly model: Model3dListed }): ReactNode {
  const { t } = useLingui()
  const from = model.source === 'photo' ? t`Made from a photo` : t`Made from words`
  return <p className="model-line__facts">{from} · <b>{creditsWords(model.credits)}</b></p>
}

/** A file's chip: its kind and size, which opens it in Files. */
function FileChip({ name, bytes, onShow }: { readonly name: string; readonly bytes: number | undefined; readonly onShow: () => void }): ReactNode {
  const { t } = useLingui()
  if (bytes === undefined) return <span className="model-line__file" title={name}><span className="model-line__extension">{extensionOf(name)}</span>{t`not found`}</span>
  return <button type="button" className="model-line__file models-tool__chip tt-focusable" onClick={onShow}
    aria-label={t({ message: `Show ${name} in Files`, comment: '{name} is a 3D model\'s file, such as Oak barrel.glb; Files is the Tools surface.' })} title={name}>
    <span className="model-line__extension">{extensionOf(name)}</span>{sizeWords(bytes)}
  </button>
}

/** A row's line under the name: the step and percent while Meshy works, else the day, or that its files are gone. */
function rowWords(model: Model3dListed): string {
  if (model.state === 'making') return modelWhen(model)
  const kinds = model.files.map(file => extensionOf(file.name)).join(' ')
  return [modelWhen(model), filesGone(model) ? t`files gone` : kinds].join(' · ')
}
