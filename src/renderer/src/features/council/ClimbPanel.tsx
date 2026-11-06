import { AskedByLine } from './AskedByLine'
import React, { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useOptionalApp } from '../../state/AppContext'
import type { CouncilPanel } from './CouncilSeats'
import { t as translate } from '@lingui/core/macro'
import type { CouncilBridge } from '../../../../shared/council'
import { climbPlannedTurns, climbSpecSchema, climbStartingCriterion, supportsClimbJudging, type ClimbCriterion, type ClimbRecord, type ClimbRequest, type ClimbResult, type ClimbSpec } from '../../../../shared/councilClimb'
import type { CouncilEvidenceSource } from '../../../../shared/councilEvidence'
import { useOptionalAgents } from '../../agents/AgentContext'
import { councilAskable } from './councilDraft'
import { OriginPicker } from './CouncilView'
import { ULTRACODE, withoutUltracode } from '../../../../shared/ultracode'

export type ClimbSeatsState = { panel: CouncilPanel; visible: boolean; disabled: boolean; onChange(panel: CouncilPanel): void }

type FormDraft = { origin: string; spec: ClimbSpec; context: string; preview?: ClimbResult['preview']; referencePreview?: ClimbResult['preview'] }
const drafts = new Map<string, FormDraft>()
const attemptSteps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]
const turnSteps = [...Array.from({ length: 20 }, (_, index) => (index + 1) * 5), null]
const criterion = (): ClimbCriterion => climbStartingCriterion(translate`Quality`, translate`0: unusable; 5: useful with substantial gaps; 10: fully meets the goal with specific evidence.`)

function Limit({ label, value, steps, onChange }: { label: string; value: number | null; steps: (number | null)[]; onChange(value: number | null): void }): ReactNode {
  const { t } = useLingui(), id = useId()
  return <label className="climb-limit council-field" htmlFor={id}><span>{label}</span><output htmlFor={id}>{value ?? t`No limit`}</output>
    <input className="theme-slider__input tt-focusable" style={{ '--theme-slider-fill': `${Math.max(0, steps.indexOf(value)) / (steps.length - 1) * 100}%` } as React.CSSProperties} id={id} type="range" min={0} max={steps.length - 1} value={Math.max(0, steps.indexOf(value))} aria-valuetext={value === null ? t`No limit` : String(value)} onChange={event => onChange(steps[Number(event.target.value)]!)} /></label>
}
function Source({ value, onChange, frozen = false }: { value: CouncilEvidenceSource; onChange(value: CouncilEvidenceSource): void; frozen?: boolean }): ReactNode {
  const { t } = useLingui()
  const sourceKind = value.kind
  const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean)
  return <fieldset className="climb-source" disabled={frozen}>
    <label className="council-field"><span>{t`Source`}</span><select className="tt-input tt-focusable" value={sourceKind} onChange={event => onChange(event.target.value === 'artifacts'
      ? { kind: 'artifacts', items: [{ path: 'draft.txt', artifactId: 'draft', content: { kind: 'text', text: '' } }] }
      : { kind: event.target.value as 'folder' | 'git', root: '', paths: [], exclude: [] })}>
      <option value="folder">{t`Folder`}</option><option value="git">{t`Git working folder`}</option><option value="artifacts">{t`Selected artifacts`}</option></select></label>
    {value.kind === 'artifacts' ? <>
      <label className="council-field"><span>{t`Artifact files (one absolute path per line)`}</span><textarea className="tt-input tt-focusable" value={value.items.filter(item => item.content.kind === 'file').map(item => item.content.kind === 'file' ? item.content.path : '').join('\n')}
        onChange={event => onChange({ ...value, items: [...value.items.filter(item => item.content.kind === 'text'), ...lines(event.target.value).map((path, index) => ({ path: `${index + 1}-${path.split(/[/\\]/u).at(-1)}`, artifactId: path, content: { kind: 'file' as const, path } }))] })} /></label>
      <label className="council-field"><span>{t`Selected text`}</span><textarea className="tt-input tt-focusable" value={value.items.find(item => item.content.kind === 'text')?.content.kind === 'text' ? (value.items.find(item => item.content.kind === 'text')!.content as { text: string }).text : ''}
        onChange={event => onChange({ ...value, items: [...value.items.filter(item => item.content.kind === 'file'), ...(event.target.value ? [{ path: 'draft.txt', artifactId: 'draft', content: { kind: 'text' as const, text: event.target.value } }] : [])] })} /></label>
    </> : <>
      <label className="council-field"><span>{t`Folder path`}</span><input className="tt-input tt-focusable" value={value.root} onChange={event => onChange({ ...value, root: event.target.value })} /></label>
      <label className="council-field"><span>{t`Selected paths (one per line; blank selects the folder)`}</span><textarea className="tt-input tt-focusable" value={value.paths.join('\n')} onChange={event => onChange({ ...value, paths: lines(event.target.value) })} /></label>
      <label className="council-field"><span>{t`Exclude paths or globs`}</span><textarea className="tt-input tt-focusable" value={value.exclude.join('\n')} onChange={event => onChange({ ...value, exclude: lines(event.target.value) })} /></label>
    </>}
  </fieldset>
}
export function ClimbPanel({ thread, bridge, onPanel, onRecord }: { thread?: string | undefined; bridge: CouncilBridge; onPanel(seats: ClimbSeatsState): void; onRecord(record: ClimbRecord | null): void }): ReactNode {
  const { t } = useLingui(), app = useOptionalApp(), agents = useOptionalAgents(), state = agents?.state
  const local = state?.connections?.find(connection => connection.kind === 'local')?.hostId
  const threads = (state?.host.threads ?? []).filter(item => councilAskable(item, local))
  const cached = drafts.get(thread ?? '')
  const [origin, setOrigin] = useState(cached?.origin ?? thread ?? ''), [records, setRecords] = useState<ClimbRecord[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [approved, setApproved] = useState(false)
  const [preview, setPreview] = useState<ClimbResult['preview']>(cached?.preview), [referencePreview, setReferencePreview] = useState<ClimbResult['preview']>(cached?.referencePreview), [notice, setNotice] = useState(''), [context, setContext] = useState(cached?.context ?? '')
  const chosen = threads.find(item => item.id === origin) ?? threads[0]
  const models = (state?.host.models ?? []).filter(model => supportsClimbJudging(model.providerId, app?.platform ?? 'win32') && model.ready && !model.legacy)
  const initialEffort = models[0]?.defaultReasoningEffort
  const defaultModelId = models[0]?.id ?? ''
  const defaultReasoningEffort = initialEffort === ULTRACODE ? withoutUltracode(models[0]?.reasoningEfforts ?? [])[0] ?? null : initialEffort ?? null
  const defaultSeat = { modelId: defaultModelId, reasoningEffort: defaultReasoningEffort }
  const [spec, setSpec] = useState<ClimbSpec>(() => cached?.spec ?? { goal: '', constraints: '', source: { kind: 'folder', root: chosen?.workingDirectory ?? state?.host.projects.find(project => project.id === chosen?.projectId)?.path ?? '', paths: [], exclude: [] },
    judges: [defaultSeat, defaultSeat, defaultSeat], chair: defaultSeat, criteria: [criterion()], attempts: 5, modelTurns: 30 })
  const ownRecords = records.filter(record => thread === undefined || record.originThread === thread)
  const current = ownRecords.find(record => record.originThread === chosen?.id && !['done', 'stopped', 'settled'].includes(record.phase))
  const shown = ownRecords.find(record => !['done', 'stopped', 'settled'].includes(record.phase)) ?? ownRecords[0] ?? null
  useEffect(() => { onRecord(shown); return () => onRecord(null) }, [shown, onRecord])
  const editable = !current || current.phase === 'approval'
  const changePanel = useCallback((panel: CouncilPanel): void => {
    setSpec(value => ({ ...value, judges: panel.panelists.map(seat => seat ?? { modelId: '', reasoningEffort: null }), chair: panel.chair ?? { modelId: '', reasoningEffort: null } })); setApproved(false)
  }, [])
  useEffect(() => { onPanel({ panel: { panelists: spec.judges, chair: spec.chair }, visible: editable, disabled: !editable || busy, onChange: changePanel }) }, [spec.judges, spec.chair, editable, busy, changePanel, onPanel])
  useEffect(() => { drafts.set(thread ?? '', { origin, spec, context, preview, referencePreview }) }, [thread, origin, spec, context, preview, referencePreview])
  useEffect(() => {
    let live = true
    const read = (): void => { void bridge.climb?.({ type: 'read' }).then(result => { if (live && result.climbs) setRecords(result.climbs) }, () => { if (live) setError(t`Sotto could not read the Climbs. Open the Council again.`) }) }
    read(); const unsubscribe = bridge.onChanged(read)
    return () => { live = false; unsubscribe() }
  }, [bridge, t])
  useEffect(() => { if (current?.phase === 'approval' && current.spec) { setSpec(current.spec); setApproved(false) } }, [current?.id, current?.phase])
  useEffect(() => {
    if (models.length > 0 && (!spec.chair.modelId || spec.judges.some(seat => !seat.modelId))) {
      const seat = { modelId: defaultModelId, reasoningEffort: defaultReasoningEffort }
      setSpec(value => ({ ...value, judges: value.judges.map(held => held.modelId ? held : seat), chair: value.chair.modelId ? value.chair : seat }))
    }
  }, [models.length, spec.chair.modelId, spec.judges, defaultModelId, defaultReasoningEffort])
  const update = (patch: Partial<ClimbSpec>): void => { setSpec(value => ({ ...value, ...patch })); setApproved(false); if (patch.source) setPreview(undefined); if ('reference' in patch) setReferencePreview(undefined) }
  const call = async (request: ClimbRequest): Promise<void> => {
    if (!bridge.climb || busy && request.type !== 'stop') return
    setBusy(true); setError('')
    try { const result = await bridge.climb(request); if (result.climbs) setRecords(result.climbs); if (result.preview) setPreview(result.preview); if (result.ok && request.type === 'export') setNotice(t`Round exported to a new folder.`); if (!result.ok) setError(result.error ?? t`The Climb could not continue.`) }
    catch { setError(t`The Climb's reply was lost. Read its status before trying again.`) }
    finally { setBusy(false) }
  }
  const valid = climbSpecSchema.safeParse(spec).success && !!chosen && (!spec.reference || !!referencePreview)
  const changeCriterion = (index: number, patch: Partial<ClimbCriterion>): void => update({ criteria: spec.criteria.map((value, at) => at === index ? { ...value, ...patch } : value) })
  return <section className="climb-panel" onKeyDown={event => {
    if (event.key !== 'Escape') return
    const details = (event.target as HTMLElement).closest('details[open]')
    if (details) { event.stopPropagation(); details.removeAttribute('open'); details.querySelector('summary')?.focus() }
  }}>
    {!current || current.phase === 'approval' ? <div className="council-ask">
      <h3 className={current ? 'climb-proposal' : 'tt-visually-hidden'}>{current ? t`Chair’s proposal` : t`Set up a Climb`}</h3>
      {current?.askedBy ? <AskedByLine askedBy={{ provider: current.askedBy.provider, words: current.askedBy.words ?? null }} /> : null}
      <fieldset disabled={!editable || busy} className="climb-fields">
        <OriginPicker threads={threads} projects={state?.host.projects ?? []} chosen={chosen?.id ?? ''} onChoose={setOrigin} />
        <p className="council-ask__estimate">{t`The From thread is the Builder throughout the run.`}</p>
        <section className="climb-fields">
          <label className="council-field"><span>{t`Goal`}</span><textarea className="tt-input tt-focusable council-ask__question" aria-label={t`Goal`} value={spec.goal} onChange={event => update({ goal: event.target.value })} /></label>
          <div><button type="button" className="council-link tt-focusable" onClick={() => update({ goal: t`Improve the clarity, hierarchy and usability of the selected design while preserving its purpose.` })}>{t`Use the Design goal`}</button></div>
          <details><summary>{t`Constraints`}</summary><div className="climb-fields"><label className="council-field"><span>{t`Constraints`}</span><textarea className="tt-input tt-focusable" aria-label={t`Constraints`} value={spec.constraints} onChange={event => update({ constraints: event.target.value })} /></label><label className="council-field"><span>{t`Context for the setup chair (optional)`}</span><textarea className="tt-input tt-focusable" disabled={!!current} value={context} onChange={event => setContext(event.target.value)} /></label></div></details>
        </section>
        <section className="council-round"><h4 className="council-round__question">{t`Evidence`}</h4>
          <Source value={spec.source} frozen={!!current} onChange={source => update({ source })} />
          <button type="button" className="tt-button tt-focusable" disabled={!!current} onClick={() => void call({ type: 'preview', source: spec.source })}>{t`Preview capture`}</button>
          {preview ? <p className="council-ask__estimate">{t`${preview.files} files · ${preview.bytes} bytes`}</p> : null}
          <details><summary>{t`Exclusions and limits`}</summary><p>{t`10,000 files · 100 MiB per capture · 20 MiB per binary · 1 GiB retained per Climb.`}</p><p>{t`Claude or Codex receives complete text and up to eight images: 400,000 text characters, 10 MiB per image and 50 MiB total. A larger or unsupported selection pauses; nothing is truncated.`}</p>
            <ul>{preview?.excluded.map(item => <li key={item.path}>{item.path} · {item.reason}</li>)}</ul></details>
          <details><summary>{t`Fixed reference (optional)`}</summary><label className="climb-checkbox"><input className="tt-focusable" type="checkbox" checked={!!spec.reference} onChange={event => update({ reference: event.target.checked ? { kind: 'artifacts', items: [] } : undefined })} />{t`Compare with fixed evidence`}</label>
            {spec.reference ? <><Source value={spec.reference} onChange={reference => update({ reference })} /><button type="button" className="tt-button tt-focusable" onClick={() => {
              void bridge.climb?.({ type: 'preview', source: spec.reference! }).then(result => { if (result.preview) setReferencePreview(result.preview); if (!result.ok) setError(result.error ?? t`The reference could not be previewed.`) }, () => setError(t`The reference could not be previewed.`))
            }}>{t`Preview reference`}</button>{referencePreview ? <p className="council-ask__estimate">{t`${referencePreview.files} reference files · ${referencePreview.bytes} bytes`}</p> : null}</> : null}</details>
        </section>
        <section className="council-round"><h4 className="council-round__question">{t`Target`}</h4>
          {spec.criteria.map((value, index) => <details key={index} open={index === 0}><summary>{value.name}</summary><div className="climb-fields">
            <label className="council-field"><span>{t`Name`}</span><input className="tt-input tt-focusable" value={value.name} onChange={event => changeCriterion(index, { name: event.target.value })} /></label>
            <label className="council-field"><span>{t`Rubric and scoring anchors`}</span><textarea className="tt-input tt-focusable" value={value.rubric} onChange={event => changeCriterion(index, { rubric: event.target.value })} /></label>
            <div className="climb-pair"><label className="council-field"><span>{t`Kind`}</span><select className="tt-input tt-focusable" value={value.kind} onChange={event => changeCriterion(index, { kind: event.target.value as ClimbCriterion['kind'] })}><option value="goal">{t`Goal`}</option><option value="guardrail">{t`Guardrail`}</option></select></label>
              <label className="council-field"><span>{t`Better scores`}</span><select className="tt-input tt-focusable" value={value.direction} onChange={event => changeCriterion(index, { direction: event.target.value as ClimbCriterion['direction'] })}><option value="higher">{t`Higher`}</option><option value="lower">{t`Lower`}</option></select></label></div>
            <label className="council-field"><span>{t`Target type`}</span><select className="tt-input tt-focusable" value={value.target} onChange={event => changeCriterion(index, { target: event.target.value as ClimbCriterion['target'] })}><option value="relative">{t`Gain over baseline`}</option><option value="absolute">{t`Absolute score`}</option><option value="reference">{t`Gain over reference`}</option></select></label>
            <div className="climb-pair">{(['min', 'max', 'threshold', 'tolerance', 'meaningfulGain'] as const).map(key => <label className="council-field" key={key}><span>{({ min: t`Minimum score`, max: t`Maximum score`, threshold: t`Target`, tolerance: t`Tolerance`, meaningfulGain: t`Meaningful gain` })[key]}</span><input className="tt-input tt-focusable" type="number" step="any" value={value[key]} onChange={event => changeCriterion(index, { [key]: Number(event.target.value) })} /></label>)}</div>
            {spec.criteria.length > 1 ? <button type="button" className="tt-button tt-focusable" onClick={() => update({ criteria: spec.criteria.filter((_, at) => at !== index) })}>{t`Remove criterion`}</button> : null}
          </div></details>)}
          <button type="button" className="tt-button tt-focusable" onClick={() => update({ criteria: [...spec.criteria, { ...criterion(), id: `criterion_${spec.criteria.length + 1}`, name: t`New criterion` }] })}>{t`Add criterion`}</button>
        </section>
        <section className="council-round"><h4 className="council-round__question">{t`Limits`}</h4>
          <Limit label={t`Attempts`} value={spec.attempts} steps={attemptSteps} onChange={attempts => update({ attempts })} /><Limit label={t`Model turns`} value={spec.modelTurns} steps={turnSteps} onChange={modelTurns => update({ modelTurns })} />
        </section>
      </fieldset>
      <p className="council-ask__estimate">{app?.settings?.historyEnabled === false ? t`History is off. Temporary evidence is written to disk while this Climb runs, then removed at Settle, quit or the next start. Its text and results are not retained.` : t`Frozen evidence and Climb results are kept on this computer while local history is on. Judge copies are temporary.`}</p>
      {current ? <div className="council-ask__actions"><label className="climb-checkbox"><input className="tt-focusable" type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />{t`Allow fix briefs to this builder within these limits.`}</label><button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!approved || !valid || busy} onClick={() => void call({ type: 'approve', climb: current.id, spec, ...(referencePreview ? { referencePreview: referencePreview.fingerprint } : {}) })}>{t`Approve & start round 0`}</button></div>
        : <div className="council-ask__actions"><button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!valid || !preview || busy} onClick={() => void call({ type: 'start', origin: chosen!.id, spec, preview: preview!.fingerprint, context, ...(referencePreview ? { referencePreview: referencePreview.fingerprint } : {}) })}>{t`Ask chair for proposal`}</button></div>}
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p className="council-notice" role="alert">{error}</p> : null}
    {ownRecords.map(record => <ClimbProgress key={record.id} record={record} busy={busy} call={call} />)}
  </section>
}
function ClimbProgress({ record, busy, call }: { record: ClimbRecord; busy: boolean; call(request: ClimbRequest): Promise<void> }): ReactNode {
  const { t } = useLingui(), [round, setRound] = useState(0), [destination, setDestination] = useState('')
  const planned = record.spec ? climbPlannedTurns(record.spec, record.turns.filter(turn => turn.repair).length) : null
  const outcome = { queued: t`Queued`, dispatching: t`Sending`, accepted: t`Working`, unconfirmed: t`Unconfirmed`, working: t`Working`, answered: t`Completed`, failed: t`Held` }
  const roundTurns = (index: number) => record.turns.filter(turn => turn.stage !== 'setup' && turn.round + (turn.stage === 'builder' ? 1 : 0) === index)
  const phases = { setup: t`Preparing proposal`, approval: t`Waiting for approval`, baseline: t`Capturing baseline`, builder: t`Building`, assessment: t`Judging`, paused: t`Held`, done: t`Finished`, stopped: t`Stopped`, settled: t`Settled` }
  return <article className="council-entry">
    <div className="council-entry__head"><div className="council-entry__title"><h2>{phases[record.phase]}</h2><p className="council-entry__meta">{t`${record.completedTurns} / ${planned ?? '∞'} turns`}</p></div>
      <div className="council-entry__actions">{record.phase === 'paused' && record.spec ? <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => void call({ type: 'resume', climb: record.id })}>{t`Continue Climb`}</button> : null}
        {!['done', 'stopped', 'settled'].includes(record.phase) ? <button type="button" className="tt-button tt-focusable" onClick={() => void call({ type: 'stop', climb: record.id })}>{t`Stop`}</button> : null}
        {['done', 'stopped'].includes(record.phase) ? <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => void call({ type: 'settle', climb: record.id })}>{t`Settle`}</button> : null}</div>
    </div>
    {record.askedBy ? <AskedByLine askedBy={{ provider: record.askedBy.provider, words: record.askedBy.words ?? null }} /> : null}
    {record.reason ? <p className="council-notice tt-paragraph" role="status">{record.reason}</p> : null}
    <ol className="council-rows">{record.turns.slice(-5).map(turn => <li className="council-row" data-state={turn.outcome === 'answered' ? 'done' : turn.outcome === 'failed' ? 'failed' : turn.delivery === 'unconfirmed' ? 'unknown' : turn.delivery === 'queued' ? 'queued' : 'working'} key={turn.id}><span>{turn.stage === 'builder' ? t`Builder` : turn.stage === 'setup' ? t`Setup chair` : turn.stage === 'chair' ? t`Chair` : t`Judge ${(turn.seat ?? 0) + 1}`}</span><span className="council-row__state">{outcome[turn.outcome ?? turn.delivery]}</span></li>)}</ol>
    <details className="council-round"><summary>{t`Turns`}</summary><div className="climb-table"><table><thead><tr><th>{t`Round`}</th><th>{t`Completed / planned`}</th></tr></thead><tbody><tr><td>{t`Setup`}</td><td>{record.turns.filter(turn => turn.stage === 'setup' && turn.outcome).length} / {Math.max(1, record.turns.filter(turn => turn.stage === 'setup').length)}</td></tr>{record.rounds.map(item => <tr key={item.index}><td>{item.index}</td><td>{roundTurns(item.index).filter(turn => turn.outcome).length} / {Math.max(item.index === 0 ? 4 : 5, roundTurns(item.index).length)}</td></tr>)}</tbody></table></div></details>
    <details className="council-round"><summary>{t`Kept rounds`}</summary>{record.rounds.map(item => <details key={item.index}><summary>{item.index === 0 ? t`Round 0 · Baseline` : t`Round ${item.index}`}{item.targetMet ? ` · ${t`Target met`}` : ''}{item.candidate === record.incumbent ? ` · ${t`Incumbent`}` : ''}</summary>
      <p>{item.summary}</p><div className="climb-table"><table><thead><tr><th>{t`Judge`}</th><th>{t`Criterion`}</th><th>{t`Exhibit`}</th><th>{t`Score`}</th><th>{t`Evidence`}</th></tr></thead><tbody>{item.judgments.flatMap(judge => judge.result.scores.map(score => <tr key={`${judge.seat}-${score.criterion}-${score.exhibit}`}><td>{judge.seat + 1}</td><td>{record.spec?.criteria.find(criterion => criterion.id === score.criterion)?.name ?? score.criterion}</td><td>{score.exhibit}</td><td>{score.score ?? t`Unmeasurable`}</td><td>{score.reason}<ul>{score.citations.map((citation, index) => <li key={index}>{citation.path}:{citation.start}–{citation.end} · {citation.quote}</li>)}</ul></td></tr>))}</tbody></table></div>
      <ul>{item.exhibits.map(exhibit => <li key={exhibit.letter}>{exhibit.letter} · {exhibit.evidence === item.baseline ? t`Baseline` : exhibit.evidence === item.reference ? t`Reference` : exhibit.evidence === item.incumbent ? t`Incumbent` : t`Candidate`}</li>)}</ul>
    </details>)}</details>
    {record.rounds.length ? <details className="council-round"><summary>{t`Export to a new folder`}</summary><label className="council-field"><span>{t`Round`}</span><select className="tt-input tt-focusable" value={round} onChange={event => setRound(Number(event.target.value))}>{record.rounds.map(item => <option key={item.index} value={item.index}>{item.index}</option>)}</select></label><label className="council-field"><span>{t`New folder path`}</span><input className="tt-input tt-focusable" value={destination} onChange={event => setDestination(event.target.value)} /></label><button type="button" className="tt-button tt-focusable" disabled={!destination || busy} onClick={() => void call({ type: 'export', climb: record.id, round, destination })}>{t`Export round`}</button></details> : null}
  </article>
}
