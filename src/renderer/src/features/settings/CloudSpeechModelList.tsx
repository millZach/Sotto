import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'

import type { CloudSpeechModel, CloudSpeechModelList as ModelList } from '../../../../shared/contracts'
import { Button } from '../../components/Button'
import './cloudSpeechModels.css'

/** The rows shown before Show all: enough to choose from without a long page. */
const TOP = 5
/** The error rate and the wait that draw an empty bar; anything better draws more of it. */
const WORST_WER = 0.06
const SLOWEST_MS = 2_000

const fill = (value: number, worst: number): string => `${Math.round(Math.max(0.04, Math.min(1, 1 - value / worst)) * 100)}%`

/**
 * OpenRouter's speech models, best first, as a ranked list (ADR-0160, Zach's pick B of
 * docs/prototypes/cloud-dictation-prototype.html). Each row says how many words it got wrong and how long it took on
 * Sotto's test clips; its price and whether its host keeps audio show on hover or focus. The list is read when the
 * group opens. Picking a row saves it; the arrow keys move between rows the way any set of radio buttons does.
 */
export function CloudSpeechModelList({ choice, onChoose, onList }: {
  /** The saved choice, or null for the first in the ranking. */
  readonly choice: string | null
  readonly onChoose: (id: string) => void
  readonly onList: () => Promise<ModelList>
}): ReactNode {
  const { t } = useLingui()
  const [list, setList] = useState<ModelList | null>(null)
  const [all, setAll] = useState(false)
  const reading = useRef(0)
  const labelId = useId()
  const rows = useRef(new Map<string, HTMLDivElement>())

  const read = useCallback(() => {
    const version = ++reading.current
    setList(null)
    void onList().catch((): ModelList => ({ ok: false, reason: 'network' })).then((answer) => {
      if (version === reading.current) setList(answer)
    })
  }, [onList])
  useEffect(() => { read() }, [read])

  const models = list?.ok === true ? list.models : []
  const chosen = choice ?? models[0]?.id ?? null
  const chosenAt = models.findIndex((model) => model.id === chosen)
  // The saved model stays in view even when it is ranked below the top five.
  const shown = all || chosenAt >= TOP ? models : models.slice(0, TOP)

  const move = (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : step === 0 ? null : (index + step + shown.length) % shown.length
    if (to === null) {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); onChoose(shown[index]!.id) }
      return
    }
    event.preventDefault()
    const next = shown[to]!
    onChoose(next.id)
    rows.current.get(next.id)?.focus()
  }

  let body: ReactNode
  if (list === null) {
    body = <p className="cloud-models__note tt-paragraph" role="status">{t`Reading OpenRouter’s speech models…`}</p>
  } else if (!list.ok) {
    body = <div className="cloud-models__note" role="status">
      <p className="tt-paragraph">{t`OpenRouter’s speech models could not be read. Nothing was changed.`}</p>
      <Button variant="secondary" onClick={read}>{t`Try again`}</Button>
    </div>
  } else {
    const gone = choice !== null && chosenAt < 0
    body = <>
      {gone ? <p className="cloud-models__note cloud-models__note--warn tt-paragraph" role="status">{t`OpenRouter no longer lists ${choice}. Dictation will fail until you pick another.`}</p> : null}
      <div className="cloud-models__table">
        <div className="cloud-models__head" aria-hidden="true">
          <span>#</span><span /><span>{t`Model`}</span><span>{t`Accuracy`}</span><span>{t`Speed`}</span>
        </div>
        <div role="radiogroup" aria-labelledby={labelId} data-setting="cloud-speech-model" className="cloud-models__rows">
          {shown.map((model, index) => (
            <ModelRow key={model.id} model={model} rank={models.indexOf(model) + 1} checked={model.id === chosen}
              focusable={model.id === chosen || (chosenAt < 0 && index === 0)}
              rowRef={(node) => { if (node === null) rows.current.delete(model.id); else rows.current.set(model.id, node) }}
              onChoose={() => onChoose(model.id)} onKeyDown={(event) => move(event, index)} />
          ))}
        </div>
        {models.length > TOP && chosenAt < TOP ? (
          <button type="button" className="cloud-models__more tt-focusable" onClick={() => setAll(!all)}>
            {all ? t`Show the top five` : t`Show all ${models.length} models`}
          </button>
        ) : null}
      </div>
    </>
  }

  return <div className="cloud-models">
    <div className="cloud-models__label">
      <span id={labelId} className="cloud-models__title">{t`OpenRouter speech model`}</span>
      <span className="cloud-models__description tt-paragraph">{t`Best first, by words wrong and seconds to the text on Sotto’s test clips. Hover a model for its price and whether its host keeps audio.`}</span>
    </div>
    {body}
  </div>
}

function ModelRow({ model, rank, checked, focusable, rowRef, onChoose, onKeyDown }: {
  readonly model: CloudSpeechModel
  readonly rank: number
  readonly checked: boolean
  readonly focusable: boolean
  readonly rowRef: (node: HTMLDivElement | null) => void
  readonly onChoose: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}): ReactNode {
  const { t } = useLingui()
  const tipId = useId()
  const wrong = model.wer === null ? t`Not tested yet` : t`${(model.wer * 100).toFixed(1)}% words wrong`
  const wait = model.medianMs === null ? t`Not tested yet` : t`${(model.medianMs / 1_000).toFixed(1)} s`
  const price = model.usdPerHour === null
    ? t`Its price is on openrouter.ai.`
    : t`About $${model.usdPerHour < 0.05 ? model.usdPerHour.toFixed(3) : model.usdPerHour.toFixed(2)} per hour of audio, paid with your OpenRouter key.`
  const retention = model.zdr
    ? t`Sent only to a host that keeps no audio.`
    : t`Not a zero-retention model: its host may keep your audio under its own terms.`
  const timed = model.medianMs === null ? null : t`Its text came back in ${(model.medianMs / 1_000).toFixed(1)} s on Sotto’s test clips.`
  const source = model.scoredBy === 'artificial-analysis'
    ? t`Words wrong from Artificial Analysis; Sotto has not timed it yet.`
    : model.scoredBy === null ? t`Not tested by Sotto or Artificial Analysis yet.` : null
  return <div ref={rowRef} role="radio" aria-checked={checked} aria-describedby={tipId} tabIndex={focusable ? 0 : -1}
    className="cloud-models__row tt-focusable" data-checked={checked || undefined} onClick={onChoose} onKeyDown={onKeyDown}>
    <span className="cloud-models__rank" aria-hidden="true">{model.wer === null ? '–' : rank}</span>
    <span className="cloud-models__radio" aria-hidden="true" />
    <span className="cloud-models__name">
      {model.name} <span className="cloud-models__maker">{model.maker}</span>
      {model.zdr ? null : <span className="cloud-models__keeps" aria-hidden="true" title={retention}>◆</span>}
    </span>
    <span className="cloud-models__measure">
      <span className="cloud-models__bar" aria-hidden="true"><i style={{ width: model.wer === null ? 0 : fill(model.wer, WORST_WER) }} /></span>
      <span className="cloud-models__figure">{wrong}</span>
    </span>
    <span className="cloud-models__measure cloud-models__speed">
      <span className="cloud-models__bar" aria-hidden="true"><i style={{ width: model.medianMs === null ? 0 : fill(model.medianMs, SLOWEST_MS) }} /></span>
      <span className="cloud-models__figure">{wait}</span>
    </span>
    <span id={tipId} role="tooltip" className="cloud-models__tip">
      <strong>{t`${model.name} by ${model.maker}`}</strong> {timed} {price} {retention} {source}
    </span>
  </div>
}
