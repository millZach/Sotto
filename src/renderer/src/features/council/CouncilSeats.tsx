import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { type AgentModel } from '../../../../shared/agents'
import { COUNCIL_PANELISTS_MAX, COUNCIL_PANELISTS_MIN, COUNCIL_SEAT_EFFORT, councilEffort, councilSeatNotes, councilSeatsInForce, type CouncilSeatChoice, type CouncilSeatInForce,
  type CouncilSeatNote } from '../../../../shared/council'
import { chosenModelId, resolveModel } from '../../../../shared/modelCatalog'
import { EffortPicker, effortLabel } from '../../agents/EffortPicker'
import { ModelPicker } from '../../agents/ModelPicker'
import { effortChoices } from '../../agents/ThreadOptions'
import { SegmentedControl } from '../../components/SegmentedControl'
import './council.css'

/** The panel as Settings → Council keeps it and the Ask screen starts from it: a seat each, null where Sotto fills it. */
export interface CouncilPanel { readonly panelists: readonly (CouncilSeatChoice | null)[]; readonly chair: CouncilSeatChoice | null }

/** A seat's name on the page: panelists by their place, which becomes their letter in a Council, and the chair; `inSentence` for one mid-sentence. */
export function useSeatName(): (seat: number | 'chair', inSentence?: boolean) => string {
  const { t } = useLingui()
  return (seat, inSentence = false) => seat !== 'chair' ? t`Panelist ${seat + 1}` : inSentence ? t({ message: 'the chair', comment: 'The Council\'s chair, in the middle of a sentence' }) : t({ message: 'Chair', comment: 'The Council\'s chair, as a seat\'s label' })
}

/** What the page says about the seats (ADR-0177 decision 7), in a sentence each. */
export function useSeatNotes(): (notes: readonly CouncilSeatNote[]) => string[] {
  const { t } = useLingui()
  const named = useSeatName()
  return notes => {
    // With no provider connected every seat is empty: one sentence says so.
    if (notes.length > 0 && notes.every(note => note.kind === 'no-seat')) return [t`No provider is connected. Connect one in Settings, under Providers.`]
    return notes.map(note => {
      const name = named(note.seat, true)
      const Name = named(note.seat)
      if (note.kind === 'no-seat') return t`No connected provider can fill the seat of ${name}. Connect one in Settings, under Providers.`
      if (note.kind === 'not-ready') return t`The provider of ${name} is not connected. Choose another model, or connect it in Settings, under Providers.`
      return t`${Name} runs in the cloud, so its claims about the code will be unchecked.`
    })
  }
}

/**
 * The panel's seats: how many panelists, each one's model and effort, and the chair's, with what the page says about
 * them. Settings → Council saves each change; the Ask screen keeps them for one Council. A seat Sotto fills shows the
 * model it fills it with; choosing one makes the seat the user's.
 */
export function CouncilSeats({ panel, catalog, onChange, setting, judging = false, disabled = false }: {
  readonly panel: CouncilPanel
  readonly catalog: readonly AgentModel[]
  readonly onChange: (panel: CouncilPanel) => void
  /** The setting the panel stands for in Find a setting. */
  readonly setting?: string
  /** Climb has exactly three named judges and requires a concrete model in every seat. */
  readonly judging?: boolean
  readonly disabled?: boolean
}): ReactNode {
  const { t } = useLingui()
  const named = useSeatName()
  const sentences = useSeatNotes()
  const seats = councilSeatsInForce(panel.panelists, panel.chair, catalog)
  const notes = judging ? [] : sentences(councilSeatNotes(seats))
  const choose = (inForce: CouncilSeatInForce | undefined, modelId: string): CouncilSeatChoice => {
    const id = chosenModelId(catalog, modelId, inForce?.modelId ?? '')
    return { modelId: id, reasoningEffort: councilEffort(inForce?.reasoningEffort ?? COUNCIL_SEAT_EFFORT, resolveModel(catalog, id)) }
  }
  const setPanelist = (index: number, seat: CouncilSeatChoice): void => onChange({ ...panel, panelists: panel.panelists.map((held, at) => at === index ? seat : held) })
  const counts = Array.from({ length: COUNCIL_PANELISTS_MAX - COUNCIL_PANELISTS_MIN + 1 }, (_, index) => String(COUNCIL_PANELISTS_MIN + index))
  return <div className="council-seats" data-setting={setting} data-judging={judging || undefined}>
    {!judging ? <div className="council-seats__count">
      <span aria-hidden="true">{t`Panelists`}</span>
      <SegmentedControl label={t`How many panelists`} value={String(panel.panelists.length)} options={counts.map(value => ({ value, label: value }))}
        onChange={value => {
          const size = Number(value)
          onChange({ ...panel, panelists: Array.from({ length: size }, (_, index) => panel.panelists[index] ?? null) })
        }} />
    </div> : null}
    <div className="council-seats__list">
      {seats.panelists.map((seat, index) => <Seat key={index} name={judging ? t`Judge ${index + 1}` : named(index)} seat={seat} catalog={catalog} disabled={disabled}
        onModel={modelId => setPanelist(index, choose(seat, modelId))}
        onEffort={effort => seat && setPanelist(index, { modelId: seat.modelId, reasoningEffort: effort })} />)}
      <Seat name={named('chair')} seat={seats.chair} catalog={catalog} chair disabled={disabled}
        onModel={modelId => onChange({ ...panel, chair: choose(seats.chair, modelId) })}
        onEffort={effort => seats.chair && onChange({ ...panel, chair: { modelId: seats.chair.modelId, reasoningEffort: effort } })} />
    </div>
    {notes.map(note => <p key={note} className="council-seats__note tt-paragraph">{note}</p>)}
  </div>
}

function Seat({ name, seat, catalog, chair = false, disabled, onModel, onEffort }: {
  readonly name: string; readonly seat: CouncilSeatInForce | undefined; readonly catalog: readonly AgentModel[]; readonly chair?: boolean; readonly disabled: boolean
  readonly onModel: (modelId: string) => void; readonly onEffort: (effort: string) => void
}): ReactNode {
  const { t } = useLingui()
  const model = seat?.model
  const modelName = model?.name ?? seat?.modelId ?? ''
  const efforts = model ? effortChoices(model, seat?.reasoningEffort ?? model.defaultReasoningEffort ?? '') : []
  const effortNow = seat?.reasoningEffort ? effortLabel(seat.reasoningEffort) : t`the model’s default`
  return <div className="council-seat" data-chair={chair || undefined} data-away={seat !== undefined && !seat.ready || undefined}>
    <span className="council-seat__name">{name}</span>
    {seat ? <>
      <div className="council-seat__field">
        <ModelPicker models={[...catalog]} modelId={seat.modelId} disabled={disabled} label={t`Choose the model for ${name}. Now ${modelName}`} onChange={onModel} />
      </div>
      <div className="council-seat__field">
        {efforts.length > 0 && model ? <EffortPicker key={seat.modelId} value={seat.reasoningEffort ?? model.defaultReasoningEffort ?? ''} options={efforts} disabled={disabled}
          label={t`Choose the reasoning effort for ${name}. Now ${effortNow}`} defaultValue={model.defaultReasoningEffort} modelName={model.name} onChange={onEffort} />
          : <span className="council-seat__none">{t({ message: `${modelName} has none`, comment: 'The model offers no reasoning effort levels' })}</span>}
      </div>
    </> : <span className="council-seat__none council-seat__none--wide">{t`No connected provider`}</span>}
  </div>
}
