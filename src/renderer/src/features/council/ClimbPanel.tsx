import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useOptionalApp } from '../../state/AppContext'
import type { CouncilPanel } from './CouncilSeats'
import { t as translate } from '@lingui/core/macro'
import type { CouncilBridge } from '../../../../shared/council'
import { climbPlannedTurns, climbSpecSchema, type ClimbCriterion, type ClimbRecord, type ClimbRequest, type ClimbResult, type ClimbSpec } from '../../../../shared/councilClimb'
import type { CouncilEvidenceSource } from '../../../../shared/councilEvidence'
import { useOptionalAgents } from '../../agents/AgentContext'
import { councilAskable } from './councilDraft'
import { OriginPicker } from './CouncilView'
import { ULTRACODE, withoutUltracode } from '../../../../shared/ultracode'

type FormDraft = { spec: ClimbSpec; context: string; preview?: ClimbResult['preview']; referencePreview?: ClimbResult['preview'] }
const drafts = new Map<string, FormDraft>()
const attemptSteps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]
const turnSteps = [...Array.from({ length: 20 }, (_, index) => (index + 1) * 5), null]
const criterion = (): ClimbCriterion => ({ id: 'quality', name: translate`Quality`, rubric: translate`0: unusable; 5: useful with substantial gaps; 10: fully meets the goal with specific evidence.`,
  kind: 'goal', direction: 'higher', min: 0, max: 10, target: 'relative', threshold: 1, tolerance: 0, meaningfulGain: 0.5 })

function Help({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const id = useId(), [open, setOpen] = useState(false)
  return <span className="climb-help"><button type="button" className="tt-focusable" aria-label={label} aria-describedby={open ? id : undefined}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>?</button>
    {open ? <span role="tooltip" id={id}>{children}</span> : null}</span>
}
function Limit({ label, value, steps, onChange }: { label: string; value: number | null; steps: (number | null)[]; onChange(value: number | null): void }): ReactNode {
  const { t } = useLingui(), id = useId()
  return <label className="climb-limit" htmlFor={id}><span>{label}</span><output htmlFor={id}>{value ?? t`No limit`}</output>
    <input id={id} type="range" min={0} max={steps.length - 1} value={Math.max(0, steps.indexOf(value))} aria-valuetext={value === null ? t`No limit` : String(value)} onChange={event => onChange(steps[Number(event.target.value)]!)} /></label>
}
function Source({ value, onChange, frozen = false }: { value: CouncilEvidenceSource; onChange(value: CouncilEvidenceSource): void; frozen?: boolean }): ReactNode {
  const { t } = useLingui()
  const sourceKind = value.kind
  const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean)
  return <fieldset className="climb-source" disabled={frozen}>
    <label>{t`Source`}<select value={sourceKind} onChange={event => onChange(event.target.value === 'artifacts'
      ? { kind: 'artifacts', items: [{ path: 'draft.txt', artifactId: 'draft', content: { kind: 'text', text: '' } }] }
      : { kind: event.target.value as 'folder' | 'git', root: '', paths: [], exclude: [] })}>
      <option value="folder">{t`Folder`}</option><option value="git">{t`Git working folder`}</option><option value="artifacts">{t`Selected artifacts`}</option></select></label>
    {value.kind === 'artifacts' ? <>
      <label>{t`Artifact files (one absolute path per line)`}<textarea value={value.items.filter(item => item.content.kind === 'file').map(item => item.content.kind === 'file' ? item.content.path : '').join('\n')}
        onChange={event => onChange({ ...value, items: [...value.items.filter(item => item.content.kind === 'text'), ...lines(event.target.value).map((path, index) => ({ path: `${index + 1}-${path.split(/[/\\]/u).at(-1)}`, artifactId: path, content: { kind: 'file' as const, path } }))] })} /></label>
      <label>{t`Selected text`}<textarea value={value.items.find(item => item.content.kind === 'text')?.content.kind === 'text' ? (value.items.find(item => item.content.kind === 'text')!.content as { text: string }).text : ''}
        onChange={event => onChange({ ...value, items: [...value.items.filter(item => item.content.kind === 'file'), ...(event.target.value ? [{ path: 'draft.txt', artifactId: 'draft', content: { kind: 'text' as const, text: event.target.value } }] : [])] })} /></label>
    </> : <>
      <label>{t`Folder path`}<input value={value.root} onChange={event => onChange({ ...value, root: event.target.value })} /></label>
      <label>{t`Selected paths (one per line; blank selects the folder)`}<textarea value={value.paths.join('\n')} onChange={event => onChange({ ...value, paths: lines(event.target.value) })} /></label>
      <label>{t`Exclude paths or globs`}<textarea value={value.exclude.join('\n')} onChange={event => onChange({ ...value, exclude: lines(event.target.value) })} /></label>
    </>}
  </fieldset>
}
export function ClimbPanel({ thread, bridge, onPanel, onRecord }: { thread?: string | undefined; bridge: CouncilBridge; onPanel(panel: CouncilPanel): void; onRecord(record: ClimbRecord | null): void }): ReactNode {
  const { t } = useLingui(), app = useOptionalApp(), agents = useOptionalAgents(), state = agents?.state
  const local = state?.connections?.find(connection => connection.kind === 'local')?.hostId
  const threads = (state?.host.threads ?? []).filter(item => councilAskable(item, local))
  const [origin, setOrigin] = useState(thread ?? ''), [records, setRecords] = useState<ClimbRecord[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [approved, setApproved] = useState(false)
  const cached = drafts.get(thread ?? '')
  const [preview, setPreview] = useState<ClimbResult['preview']>(cached?.preview), [referencePreview, setReferencePreview] = useState<ClimbResult['preview']>(cached?.referencePreview), [notice, setNotice] = useState(''), [context, setContext] = useState(cached?.context ?? '')
  const chosen = threads.find(item => item.id === origin) ?? threads[0]
  const models = (state?.host.models ?? []).filter(model => model.providerId === 'claude' && model.ready && !model.legacy)
  const initialEffort = models[0]?.defaultReasoningEffort
  const defaultSeat = { modelId: models[0]?.id ?? '', reasoningEffort: initialEffort === ULTRACODE ? withoutUltracode(models[0]?.reasoningEfforts ?? [])[0] ?? null : initialEffort ?? null }
  const [spec, setSpec] = useState<ClimbSpec>(() => cached?.spec ?? { goal: '', constraints: '', source: { kind: 'folder', root: chosen?.workingDirectory ?? state?.host.projects.find(project => project.id === chosen?.projectId)?.path ?? '', paths: [], exclude: [] },
    judges: [defaultSeat, defaultSeat, defaultSeat], chair: defaultSeat, criteria: [criterion()], attempts: 5, modelTurns: 30 })
  useEffect(() => { onPanel({ panelists: spec.judges, chair: spec.chair }) }, [spec.judges, spec.chair, onPanel])
  const current = records.find(record => record.originThread === chosen?.id && !['done', 'stopped', 'settled'].includes(record.phase))
  const shown = current ?? records.find(record => record.originThread === chosen?.id) ?? null
  useEffect(() => { onRecord(shown); return () => onRecord(null) }, [shown, onRecord])
  const editable = !current || current.phase === 'approval'
  useEffect(() => { drafts.set(thread ?? '', { spec, context, preview, referencePreview }) }, [thread, spec, context, preview, referencePreview])
  useEffect(() => {
    let live = true
    const read = (): void => { void bridge.climb?.({ type: 'read' }).then(result => { if (live && result.climbs) setRecords(result.climbs) }, () => { if (live) setError(t`Sotto could not read the Climbs. Open the Council again.`) }) }
    read(); const unsubscribe = bridge.onChanged(read)
    return () => { live = false; unsubscribe() }
  }, [bridge, t])
  useEffect(() => { if (current?.phase === 'approval' && current.spec) { setSpec(current.spec); setApproved(false) } }, [current?.id, current?.phase])
  useEffect(() => {
    if (models.length && !spec.chair.modelId) setSpec(value => ({ ...value, judges: value.judges.map(seat => seat.modelId ? seat : defaultSeat), chair: defaultSeat }))
  }, [models.length, spec.chair.modelId])
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
  return <section className="climb-panel">
    <OriginPicker threads={threads} projects={state?.host.projects ?? []} chosen={chosen?.id ?? ''} onChoose={setOrigin} />
    {!current || current.phase === 'approval' ? <>
      <div className="climb-heading"><h3>{current ? t`Chair’s proposal` : t`Set up a Climb`}</h3><span>{t`Before round 0`}</span></div>
      <fieldset disabled={!editable || busy} className="climb-fields">
        <section className="climb-card"><h4>{t`Goal`} <Help label={t`About the goal`}>{t`Climb works on any kind of work. Design is one preset. The chair proposes a rubric; you approve it before the baseline is judged.`}</Help></h4>
          <select aria-label={t`Goal preset`} defaultValue="custom" onChange={event => { if (event.target.value === 'design') update({ goal: t`Improve the clarity, hierarchy and usability of the selected design while preserving its purpose.` }) }}><option value="custom">{t`Custom`}</option><option value="design">{t`Design`}</option></select>
          <textarea aria-label={t`Goal`} value={spec.goal} onChange={event => update({ goal: event.target.value })} />
          <details><summary>{t`Constraints`}</summary><textarea aria-label={t`Constraints`} value={spec.constraints} onChange={event => update({ constraints: event.target.value })} /></details>
        </section>
        <section className="climb-card"><h4>{t`Evidence`} <Help label={t`About evidence`}>{t`Frozen copies go only to the selected judges. Git is optional. Links, caches, environment files and private keys are excluded by default. Over a limit, nothing is partially captured.`}</Help></h4>
          <Source value={spec.source} frozen={!!current} onChange={source => update({ source })} />
          <button type="button" className="tt-focusable" disabled={!!current} onClick={() => void call({ type: 'preview', source: spec.source })}>{t`Preview capture`}</button>
          {preview ? <p>{t`${preview.files} files · ${preview.bytes} bytes`}</p> : null}
          <details><summary>{t`Exclusions and limits`}</summary><p>{t`10,000 files · 100 MiB per capture · 20 MiB per binary · 1 GiB retained per Climb.`}</p><p>{t`Claude receives complete text and up to eight images: 400,000 text characters, 10 MiB per image and 50 MiB total. A larger or unsupported selection pauses; nothing is truncated.`}</p>
            <ul>{preview?.excluded.map(item => <li key={item.path}>{item.path} · {item.reason}</li>)}</ul></details>
          <details><summary>{t`Fixed reference (optional)`}</summary><label><input type="checkbox" checked={!!spec.reference} onChange={event => update({ reference: event.target.checked ? { kind: 'artifacts', items: [] } : undefined })} />{t`Compare with fixed evidence`}</label>
            {spec.reference ? <><Source value={spec.reference} onChange={reference => update({ reference })} /><button type="button" onClick={() => {
              void bridge.climb?.({ type: 'preview', source: spec.reference! }).then(result => { if (result.preview) setReferencePreview(result.preview); if (!result.ok) setError(result.error ?? t`The reference could not be previewed.`) }, () => setError(t`The reference could not be previewed.`))
            }}>{t`Preview reference`}</button>{referencePreview ? <p>{t`${referencePreview.files} reference files · ${referencePreview.bytes} bytes`}</p> : null}</> : null}</details>
        </section>
        <section className="climb-card"><h4>{t`Judge`} <Help label={t`About judges`}>{t`Three fresh, independent judges read each round, followed by a fresh chair. Targets, origin context and past scores stay out of judging prompts. Only Claude currently enforces this tool-free mode.`}</Help></h4>
          {[...spec.judges, spec.chair].map((seat, index) => <div className="climb-seat" key={index}><label>{index === 3 ? t`Chair` : t`Judge ${index + 1}`}<select value={seat.modelId} onChange={event => { const next = { ...seat, modelId: event.target.value }; update(index === 3 ? { chair: next } : { judges: spec.judges.map((value, at) => at === index ? next : value) }) }}><option value="">{t`Choose a model`}</option>{models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
            <label>{t`Effort`}<select value={seat.reasoningEffort ?? ''} onChange={event => { const next = { ...seat, reasoningEffort: event.target.value || null }; update(index === 3 ? { chair: next } : { judges: spec.judges.map((value, at) => at === index ? next : value) }) }}><option value="">{t`Default`}</option>{withoutUltracode(models.find(model => model.id === seat.modelId)?.reasoningEfforts ?? []).map(effort => <option key={effort}>{effort}</option>)}</select></label></div>)}
        </section>
        <section className="climb-card"><h4>{t`Target`} <Help label={t`About targets`}>{t`Every judge must pass every criterion. Relative improvement uses the baseline judged in the same round. No regression beyond tolerance is allowed when choosing a new incumbent.`}</Help></h4>
          {spec.criteria.map((value, index) => <details key={index} open={index === 0}><summary>{value.name}</summary><div className="climb-fields">
            <label>{t`Name`}<input value={value.name} onChange={event => changeCriterion(index, { name: event.target.value })} /></label>
            <label>{t`Rubric and scoring anchors`}<textarea value={value.rubric} onChange={event => changeCriterion(index, { rubric: event.target.value })} /></label>
            <div className="climb-pair"><label>{t`Kind`}<select value={value.kind} onChange={event => changeCriterion(index, { kind: event.target.value as ClimbCriterion['kind'] })}><option value="goal">{t`Goal`}</option><option value="guardrail">{t`Guardrail`}</option></select></label>
              <label>{t`Better scores`}<select value={value.direction} onChange={event => changeCriterion(index, { direction: event.target.value as ClimbCriterion['direction'] })}><option value="higher">{t`Higher`}</option><option value="lower">{t`Lower`}</option></select></label></div>
            <label>{t`Target type`}<select value={value.target} onChange={event => changeCriterion(index, { target: event.target.value as ClimbCriterion['target'] })}><option value="relative">{t`Gain over baseline`}</option><option value="absolute">{t`Absolute score`}</option><option value="reference">{t`Gain over reference`}</option></select></label>
            <div className="climb-pair">{(['min', 'max', 'threshold', 'tolerance', 'meaningfulGain'] as const).map(key => <label key={key}>{({ min: t`Minimum score`, max: t`Maximum score`, threshold: t`Target`, tolerance: t`Tolerance`, meaningfulGain: t`Meaningful gain` })[key]}<input type="number" step="any" value={value[key]} onChange={event => changeCriterion(index, { [key]: Number(event.target.value) })} /></label>)}</div>
            {spec.criteria.length > 1 ? <button type="button" onClick={() => update({ criteria: spec.criteria.filter((_, at) => at !== index) })}>{t`Remove criterion`}</button> : null}
          </div></details>)}
          <button type="button" onClick={() => update({ criteria: [...spec.criteria, { ...criterion(), id: `criterion_${spec.criteria.length + 1}`, name: t`New criterion` }] })}>{t`Add criterion`}</button>
        </section>
        <section className="climb-card"><h4>{t`Builder`}</h4><p>{chosen?.title}</p><label>{t`Context for the setup chair (optional)`}<textarea disabled={!!current} value={context} onChange={event => setContext(event.target.value)} /></label></section>
        <section className="climb-card"><h4>{t`Limits`} <Help label={t`About stop rules`}>{t`Stops when all targets pass, after two completed attempts without meaningful improvement, or when you press Stop. Each slider controls its own cap.`}</Help></h4>
          <Limit label={t`Attempts`} value={spec.attempts} steps={attemptSteps} onChange={attempts => update({ attempts })} /><Limit label={t`Model turns`} value={spec.modelTurns} steps={turnSteps} onChange={modelTurns => update({ modelTurns })} />
        </section>
      </fieldset>
      <p className="council-muted">{app?.settings?.historyEnabled === false ? t`History is off. Temporary evidence is written to disk while this Climb runs, then removed at Settle, quit or the next start. Its text and results are not retained.` : <Help label={t`About kept evidence`}>{t`Frozen evidence and Climb results are kept on this computer while local history is on. Judge copies are temporary.`}</Help>}</p>
      {current ? <div className="climb-actions"><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />{t`Allow fix briefs to this builder within these limits.`}</label><button type="button" className="tt-focusable" disabled={!approved || !valid || busy} onClick={() => void call({ type: 'approve', climb: current.id, spec, ...(referencePreview ? { referencePreview: referencePreview.fingerprint } : {}) })}>{t`Approve & start round 0`}</button></div>
        : <button type="button" className="tt-focusable" disabled={!valid || !preview || busy} onClick={() => void call({ type: 'start', origin: chosen!.id, spec, preview: preview!.fingerprint, context, ...(referencePreview ? { referencePreview: referencePreview.fingerprint } : {}) })}>{t`Ask chair for proposal`}</button>}
    </> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p className="council-notice" role="alert">{error}</p> : null}
    {records.filter(record => record.originThread === chosen?.id).map(record => <ClimbProgress key={record.id} record={record} busy={busy} call={call} />)}
  </section>
}
function ClimbProgress({ record, busy, call }: { record: ClimbRecord; busy: boolean; call(request: ClimbRequest): Promise<void> }): ReactNode {
  const { t } = useLingui(), [round, setRound] = useState(0), [destination, setDestination] = useState('')
  const planned = record.spec ? climbPlannedTurns(record.spec, record.turns.filter(turn => turn.repair).length) : null
  const outcome = { queued: t`Queued`, dispatching: t`Sending`, accepted: t`Working`, unconfirmed: t`Unconfirmed`, working: t`Working`, answered: t`Completed`, failed: t`Held` }
  const roundTurns = (index: number) => record.turns.filter(turn => turn.stage !== 'setup' && turn.round + (turn.stage === 'builder' ? 1 : 0) === index)
  const phases = { setup: t`Preparing proposal`, approval: t`Waiting for approval`, baseline: t`Capturing baseline`, builder: t`Building`, assessment: t`Judging`, paused: t`Held`, done: t`Finished`, stopped: t`Stopped`, settled: t`Settled` }
  return <article className="climb-progress"><div className="climb-heading"><h3>{phases[record.phase]}</h3><span>{t`${record.completedTurns} / ${planned ?? '∞'} turns`}</span></div>
    {record.reason ? <p role="status">{record.reason}</p> : null}
    <ol className="climb-turns">{record.turns.slice(-5).map(turn => <li key={turn.id}><span>{turn.stage === 'builder' ? t`Builder` : turn.stage === 'setup' ? t`Setup chair` : turn.stage === 'chair' ? t`Chair` : t`Judge ${(turn.seat ?? 0) + 1}`}</span><span>{outcome[turn.outcome ?? turn.delivery]}</span></li>)}</ol>
    <div className="climb-actions">{record.phase === 'paused' && record.spec ? <button type="button" disabled={busy} onClick={() => void call({ type: 'resume', climb: record.id })}>{t`Continue Climb`}</button> : null}
      {!['done', 'stopped', 'settled'].includes(record.phase) ? <button type="button" onClick={() => void call({ type: 'stop', climb: record.id })}>{t`Stop`}</button> : null}
      {['done', 'stopped'].includes(record.phase) ? <button type="button" disabled={busy} onClick={() => void call({ type: 'settle', climb: record.id })}>{t`Settle`}</button> : null}</div>
    <details><summary>{t`Turns`}</summary><table><thead><tr><th>{t`Round`}</th><th>{t`Completed / planned`}</th></tr></thead><tbody><tr><td>{t`Setup`}</td><td>{record.turns.filter(turn => turn.stage === 'setup' && turn.outcome).length} / {Math.max(1, record.turns.filter(turn => turn.stage === 'setup').length)}</td></tr>{record.rounds.map(item => <tr key={item.index}><td>{item.index}</td><td>{roundTurns(item.index).filter(turn => turn.outcome).length} / {Math.max(item.index === 0 ? 4 : 5, roundTurns(item.index).length)}</td></tr>)}</tbody></table></details>
    <details><summary>{t`Kept rounds`}</summary>{record.rounds.map(item => <details key={item.index}><summary>{item.index === 0 ? t`Round 0 · Baseline` : t`Round ${item.index}`}{item.targetMet ? ` · ${t`Target met`}` : ''}{item.candidate === record.incumbent ? ` · ${t`Incumbent`}` : ''}</summary>
      <p>{item.summary}</p><div className="climb-table"><table><thead><tr><th>{t`Judge`}</th><th>{t`Criterion`}</th><th>{t`Exhibit`}</th><th>{t`Score`}</th><th>{t`Evidence`}</th></tr></thead><tbody>{item.judgments.flatMap(judge => judge.result.scores.map(score => <tr key={`${judge.seat}-${score.criterion}-${score.exhibit}`}><td>{judge.seat + 1}</td><td>{record.spec?.criteria.find(criterion => criterion.id === score.criterion)?.name ?? score.criterion}</td><td>{score.exhibit}</td><td>{score.score ?? t`Unmeasurable`}</td><td>{score.reason}<ul>{score.citations.map((citation, index) => <li key={index}>{citation.path}:{citation.start}–{citation.end} · {citation.quote}</li>)}</ul></td></tr>))}</tbody></table></div>
      <ul>{item.exhibits.map(exhibit => <li key={exhibit.letter}>{exhibit.letter} · {exhibit.evidence === item.baseline ? t`Baseline` : exhibit.evidence === item.reference ? t`Reference` : exhibit.evidence === item.incumbent ? t`Incumbent` : t`Candidate`}</li>)}</ul>
    </details>)}</details>
    {record.rounds.length ? <details><summary>{t`Export to a new folder`}</summary><label>{t`Round`}<select value={round} onChange={event => setRound(Number(event.target.value))}>{record.rounds.map(item => <option key={item.index} value={item.index}>{item.index}</option>)}</select></label><label>{t`New folder path`}<input value={destination} onChange={event => setDestination(event.target.value)} /></label><button type="button" disabled={!destination || busy} onClick={() => void call({ type: 'export', climb: record.id, round, destination })}>{t`Export round`}</button></details> : null}
  </article>
}
