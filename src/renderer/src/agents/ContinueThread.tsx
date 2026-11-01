import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CornerDownRight, CornerUpLeft, Laptop, X } from 'lucide-react'
import { msg, ph, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { hostForThread, PROVIDER_LABELS, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread, type HandoverCounts,
  type ProviderId, type ThreadContinuedIn } from '../../../shared/agents'
import { continueThreadRefusal } from '../../../shared/continueThread'
import { handoverLedger } from '../../../shared/handover'
import { resolveModel } from '../../../shared/modelCatalog'
import type { AgentConnection } from './AgentContext'
import { EffortPicker } from './EffortPicker'
import { suggestedEffortIndex } from './effortSuggestion'
import { SplitChipEffort } from './SplitChipEffort'
import { ModelPicker } from './ModelPicker'
import { usesProviderModes } from './pendingSettings'
import { ProviderMark } from './ProviderMark'
import { clockLabel } from './threadFacts'
import { ChoiceChip, effortChoices, modeChoices, PERMISSIONS_ICON, RUNTIME_LABELS, startingProviderMode } from './ThreadOptions'
import { leftToRight, shownWords, type LaterWords } from './interfaceWords'
import { continueChoiceFor, continuedSince, continueModels, continueStore, lastLimitStop, providerDefaults, unavailableProviders,
  sameFolderOffered, useContinueChoice, useContinueEnabled, useContinueLinks, type ContinueChoice } from './continuations'
import { ultracodeLevel } from './ultracodeLevel'
import './continueThread.css'

/**
 * Continuing a thread on another provider (ADR-0089, Zach's pick B of the continue prototype, in place). Nothing here
 * opens a dialog: the error offers the providers, the composer becomes "Continue on Codex" under a strip that says
 * where the new thread works and what the handover carries, and each thread links to the other in its own history.
 */

/** Why the new thread starts on a narrower permission than the source's, in the words its chip uses. */
function narrowedWords(mode: AgentRuntimeMode, narrowed: NonNullable<ContinueChoice['narrowed']>, target: string, model: string | undefined): string {
  const permission = RUNTIME_LABELS[mode], from = RUNTIME_LABELS[narrowed.from], offeredBy = model ?? target
  return narrowed.by === 'default'
    ? t`It starts on ${permission}, not this thread’s ${from}, since your new-thread default allows no more. You can change it below.`
    : t({ message: `It starts on ${permission}, the nearest ${offeredBy} offers to this thread’s ${from}. You can change it below.`, comment: '{permission} and {from} are permission levels; {offeredBy} is a model or provider name.' })
}

/** Whose limit a stop was, as the line under the composer says it. */
const LIMIT_OWNER: Partial<Record<ProviderId, string>> = { claude: 'Claude' }

/**
 * Under a turn that stopped at a usage or spending limit: the other providers this thread can continue on now, each on
 * its default model, the ones turned on that cannot with why, and More for any other model. A press begins the
 * continuation in the composer; nothing is sent until the user sends.
 */
export function ContinueNow({ thread, state, onStart }: { readonly thread: AgentThread; readonly state: AgentState; readonly onStart: () => void }): ReactNode {
  const { t } = useLingui()
  const enabled = useContinueEnabled()
  const chosen = useContinueChoice(thread.id)
  if (!enabled || lastLimitStop(thread) === undefined || continueThreadRefusal(thread) !== null || continuedSince(thread) !== undefined) return null
  const models = continueModels(state, thread)
  const unavailable = unavailableProviders(state, thread)
  if (models.length === 0 && unavailable.length === 0) return null
  const begin = (model: AgentModel, pick = false): void => {
    continueStore.set(thread.id, { ...continueChoiceFor(state, thread, model.id, chosen), ...(pick ? { pick: true as const } : {}) })
    if (!pick) onStart()
  }
  const defaults = providerDefaults(state, models)
  return <div className="continue-now" role="group" aria-label={t`Continue now on another provider`}>
    <span className="continue-now__lead"><Trans comment="Before chips naming providers: Or continue now on Codex, Grok Build…">Or continue now on</Trans></span>
    {defaults.map(model => {
      const name = model.providerId ? PROVIDER_LABELS[model.providerId] : model.provider
      const modelName = model.name
      const label = t`Continue on ${name}, ${modelName}`
      return <button key={model.id} type="button" className="continue-chip tt-focusable" aria-pressed={chosen?.modelId === model.id}
        aria-label={label} title={label} onClick={() => begin(model)}>
        <ProviderMark provider={model.providerId} name={name} />{name === model.name ? name : `${name} · ${model.name}`}</button>
    })}
    {unavailable.map(item => <button key={item.providerId} type="button" className="continue-chip tt-focusable" aria-disabled="true"
      aria-label={`${item.name}: ${item.reason}`} title={item.reason}>
      <ProviderMark provider={item.providerId} name={item.name} />{item.name}<small>· {item.short}</small></button>)}
    {models.length > defaults.length ? <button type="button" className="continue-chip tt-focusable" aria-label={t`More models to continue on`}
      title={t`More models to continue on`} onClick={() => begin(defaults[0]!, true)}>{t({ message: 'More', comment: 'Opens the list of every other model to continue on.' })}<ChevronDown size={14} aria-hidden="true" /></button> : null}
  </div>
}

/**
 * Over the composer while a continuation is begun: sending starts a new thread on the chosen provider with a handover of
 * this one, where it works and on which machine, and what the handover carries and leaves out, to read on request. X or
 * Escape puts the continuation away and the composer writes to this thread again.
 */
export function ContinueStrip({ thread, state, choice, composerId }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly choice: ContinueChoice; readonly composerId: string
}): ReactNode {
  const { t } = useLingui()
  const bridge = typeof window === 'undefined' ? undefined : window.sotto?.continueThread
  const host = hostForThread(state.host, thread)
  const model = resolveModel(host.models, choice.modelId)
  const target = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider
    ?? t({ message: 'the other provider', comment: 'Stands in for a provider name in "Continue on {continueTarget}" and the like, when the model names none.' })
  const [counts, setCounts] = useState<HandoverCounts | null>(null)
  const [readError, setReadError] = useState<LaterWords | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const strip = useRef<HTMLElement>(null)
  const readButton = useRef<HTMLButtonElement>(null)
  const putAway = useRef<() => void>(() => undefined)
  const regionId = useId()
  const messageCount = thread.summary?.messageCount ?? thread.messages.length
  // What the handover carries, read as the strip appears and again whenever the thread has said more.
  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    setText(null); setOpen(false)
    bridge.read({ threadId: thread.id }).then(read => {
      if (!live) return
      if (read.status === 'ok') { setCounts(read.counts); setReadError(null) } else setReadError(read.message)
    }, () => { if (live) setReadError(msg`Sotto could not read what the handover carries. It is built again when you send.`) })
    return () => { live = false }
  }, [bridge, thread.id, messageCount])
  // Escape from the composer under the strip puts the continuation away too, once nothing open there has taken the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const area = strip.current?.closest('.thread-workspace__compose')
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node) || !area?.contains(event.target) || strip.current?.contains(event.target)) return
      // The model picker is a dialog its Escape closes, after this listener hears the key; that Escape is the dialog's.
      if (event.target instanceof Element && event.target.closest('dialog') !== null) return
      event.preventDefault()
      putAway.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const dismiss = (): void => {
    if (choice.sending) return
    continueStore.set(thread.id, undefined)
    document.getElementById(composerId)?.focus()
  }
  putAway.current = dismiss
  const toggle = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    if (text !== null) { setOpen(true); return }
    if (bridge === undefined) return
    setReading(true)
    try {
      const read = await bridge.read({ threadId: thread.id, words: true })
      if (read.status === 'ok' && read.text !== undefined) { setText(read.text); setCounts(read.counts); setOpen(true); setReadError(null) }
      else setReadError(read.status === 'refused' ? read.message : msg`Sotto could not read the handover. Press Read it to try again.`)
    } catch { setReadError(msg`Sotto could not read the handover. Nothing was sent. Press Read it to try again.`) }
    finally { setReading(false) }
  }
  const ledger = counts === null ? null : handoverLedger(counts)
  const branch = thread.worktree?.branch ?? thread.worktree?.git?.branch ?? undefined
  const worktree = thread.worktree?.mode === 'independent'
  const sameDescription = worktree
    ? branch ? t`This thread’s worktree, on ${ph({ branch: leftToRight(branch) })}. Both threads change the same files.` : t`This thread’s worktree. Both threads change the same files.`
    : branch ? t`This thread’s project folder, on ${ph({ branch: leftToRight(branch) })}. Both threads change the same files.` : t`This thread’s project folder. Both threads change the same files.`
  const sameFolder = t({ message: 'Same folder', comment: 'Where a continued thread works: the folder this thread works in.' })
  // A worktree that was put away offers only a new one until a send to this thread brings it back (ADR-0041).
  const copies = [
    ...(sameFolderOffered(thread) ? [{ id: 'same', label: sameFolder, description: sameDescription }] : []),
    ...(branch ? [{ id: 'new-worktree', label: t`New worktree from ${ph({ branch: leftToRight(branch) })}`, description: t`Starts from ${ph({ branch: leftToRight(branch) })}’s last commit. Uncommitted changes stay where they are.` }] : []),
  ]
  const continueTarget = target
  const carried = ledger?.carried
  const leftOut = ledger?.leftOut ?? null
  return <section ref={strip} className="continue-strip" aria-label={t`Continue on ${continueTarget}`} data-tone={choice.error ? 'error' : undefined}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation()
      // Escape closes what is open first, then puts the continuation away.
      if (open) { setOpen(false); readButton.current?.focus() } else dismiss()
    }}>
    <div className="continue-strip__lead">
      <CornerDownRight size={15} aria-hidden="true" />
      <p className="tt-paragraph"><Trans>Sending starts a <strong>new {target} thread</strong> with a handover of this one.</Trans></p>
      <button type="button" className="continue-strip__dismiss tt-focusable" aria-label={t`Don’t continue: keep writing to this thread`}
        title={t`Don’t continue: keep writing to this thread`} disabled={choice.sending} onClick={dismiss}><X size={15} aria-hidden="true" /></button>
    </div>
    <div className="continue-strip__chips">
      {copies.length > 1
        ? <ChoiceChip label={t`Where the new thread works`} placeholder={sameFolder} value={choice.workingCopy} options={copies} disabled={choice.sending} pending={false}
          onChange={id => continueStore.update(thread.id, { workingCopy: id === 'new-worktree' ? 'new-worktree' : 'same' })} />
        : copies[0] ? <span className="continue-strip__fact" title={copies[0].description}>{copies[0].label}</span> : null}
      <span className="continue-strip__fact" title={t`Starting on another machine isn’t available yet.`}><Laptop size={14} aria-hidden="true" />{t`This computer`}</span>
    </div>
    <p className="continue-strip__ledger tt-paragraph">
      {counts?.historyKept === false ? <>{t`Keep local history is off, so it holds only what Sotto kept since it last started.`}{' '}</> : null}
      {carried === undefined ? readError === null ? <>{t`Reading what the handover carries…`}{' '}</> : null
        : <>{leftOut === null ? t`Handover first: it carries ${carried}.` : t`Handover first: it carries ${carried} and leaves out ${leftOut}.`}{' '}</>}
      <button ref={readButton} type="button" className="continue-strip__read tt-focusable" aria-expanded={open} aria-controls={open ? regionId : undefined}
        disabled={reading || bridge === undefined} onClick={() => void toggle()}>{open ? t`Hide it` : reading ? t`Reading it…` : t`Read it`}</button>
    </p>
    {open && text !== null ? <div id={regionId} className="continue-strip__text tt-focusable" tabIndex={0} role="region" aria-label={t`The handover, word for word`}>{text}</div> : null}
    {choice.narrowed && choice.runtimeMode ? <p className="continue-strip__permission tt-paragraph">{narrowedWords(choice.runtimeMode, choice.narrowed, target, model?.name)}</p> : null}
    {readError === null ? null : <p className="continue-strip__error tt-paragraph" role="alert">{shownWords(readError)}</p>}
    {choice.error === null ? null : <p className="continue-strip__error tt-paragraph" role="alert">{shownWords(choice.error)}</p>}
  </section>
}

/**
 * The composer's chips while a continuation is begun: the model it starts on, that model's effort, and its permissions.
 * In Zach's composer (`quiet`), effort is the word that may offer a level the draft seems to want (ADR-0172), and the
 * permissions go to their slot before the model.
 */
export function ContinueOptions({ thread, state, choice, quiet }: { readonly thread: AgentThread; readonly state: AgentState; readonly choice: ContinueChoice
  readonly quiet?: { readonly effortScore: number; readonly shieldSlot?: HTMLElement | null | undefined } | undefined }): ReactNode {
  const { t } = useLingui()
  const models = continueModels(state, thread)
  const unavailable = unavailableProviders(state, thread)
  const model = resolveModel(models, choice.modelId)
  const effort = choice.reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, effort, { ultracode: true })
  const modes = modeChoices(model, choice.runtimeMode, choice.providerMode)
  const own = usesProviderModes(model)
  // The menu opened from the error's More once; it is not asked to open again.
  useEffect(() => { if (choice.pick) continueStore.update(thread.id, { pick: undefined }) }, [choice.pick, thread.id])
  const levels = efforts.filter(option => !option.disabled).map(option => option.id)
  const permissions = modes.length > 0 ? <ChoiceChip label={t`Permissions the new thread starts on`} placeholder={t`Provider default`} value={(own ? startingProviderMode(model, choice.providerMode) : choice.runtimeMode) ?? ''}
    options={modes} disabled={choice.sending} pending={false} icon={PERMISSIONS_ICON}
    onChange={mode => continueStore.update(thread.id, own ? { providerMode: mode, narrowed: undefined } : { runtimeMode: mode as AgentRuntimeMode, narrowed: undefined })} /> : null
  return <div className="thread-options-bar">
    <div className="thread-options thread-options--chips">
      <ModelPicker models={models} modelId={choice.modelId} disabled={choice.sending} unavailable={unavailable} label={t`Model the new thread starts on`}
        openOnMount={choice.pick === true} note={t`Your first message starts a new thread on the model you pick, with a handover of this one.`}
        onChange={id => continueStore.set(thread.id, continueChoiceFor(state, thread, id, choice))} />
      {quiet ? levels.length > 0 && <SplitChipEffort key={choice.modelId} levels={levels} value={effort} disabled={choice.sending}
        suggestion={suggestedEffortIndex(quiet.effortScore, levels, effort, model?.defaultReasoningEffort)}
        onChange={reasoningEffort => continueStore.update(thread.id, { reasoningEffort })} />
        : efforts.length > 0 ? <EffortPicker key={choice.modelId} value={effort} options={efforts} disabled={choice.sending}
        defaultValue={model?.defaultReasoningEffort} modelName={model?.name} ultracodeEffort={ultracodeLevel(state, thread, model)}
        onChange={reasoningEffort => continueStore.update(thread.id, { reasoningEffort })} /> : null}
      {quiet?.shieldSlot && permissions ? createPortal(permissions, quiet.shieldSlot) : permissions}
    </div>
  </div>
}

/** At the top of a continued thread's history: the thread it continues, which stays readable there, and a way to open it. */
export function ContinuedFromNote({ thread, state, command }: { readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command'] }): ReactNode {
  const { t } = useLingui()
  const enabled = useContinueEnabled()
  const from = enabled ? thread.continuedFrom : undefined
  if (from === undefined) return null
  const source = state.host.threads.find(item => item.id === from.threadId)
  const name = PROVIDER_LABELS[from.provider]
  const title = source?.title ?? t`a thread that is no longer listed`
  const openLabel = t`Open ${title}, the thread this one continues`
  return <div className="continue-note" role="note">
    <CornerUpLeft size={15} aria-hidden="true" />
    <p className="tt-paragraph"><Trans>Continued from <ProviderMark provider={from.provider} name={name} size={13} /><strong>{title}</strong> on {name}.</Trans>
      {source ? <> <Trans>It stays readable there. <button type="button" className="continue-note__open tt-focusable" aria-label={openLabel}
        onClick={() => void command({ type: 'select-thread', threadId: source.id })}>Open it</button></Trans></> : null}</p>
  </div>
}

/** After the turn that was newest when it happened: a thread that continues this one, and a way to open it. */
export function ContinuedInNotes({ links }: { readonly links: readonly ThreadContinuedIn[] }): ReactNode {
  const { t } = useLingui()
  const context = useContinueLinks()
  if (context === null) return null
  return <>{links.map(link => {
    const target = context.threads.find(item => item.id === link.threadId)
    const name = PROVIDER_LABELS[link.provider]
    const title = target?.title ?? t`a thread that is no longer listed`
    const time = clockLabel(Date.parse(link.at))
    return <div key={link.threadId} className="continue-note" role="note">
      <CornerDownRight size={15} aria-hidden="true" />
      <p className="tt-paragraph"><Trans>Continued in <ProviderMark provider={link.provider} name={name} size={13} /><strong>{title}</strong> on {name}, {time}, with a handover of this thread.</Trans>
        {target ? <> <button type="button" className="continue-note__open tt-focusable" aria-label={t`Open ${title} on ${name}, the thread that continues this one`}
          onClick={() => context.open(target.id)}>{t`Open it`}</button></> : null}</p>
    </div>
  })}</>
}

/**
 * Under the composer of a thread that was just continued elsewhere, while nothing newer has been said in it: it can still
 * be sent to, once its limit resets where Sotto knows when.
 */
export function ContinueComposerNote({ thread }: { readonly thread: AgentThread }): ReactNode {
  const { t } = useLingui()
  const enabled = useContinueEnabled()
  const newest = enabled ? continuedSince(thread) : undefined
  if (newest === undefined) return null
  const stop = lastLimitStop(thread)
  const owner = stop ? LIMIT_OWNER[stop.provider] : undefined
  const provider = PROVIDER_LABELS[newest.provider]
  const resetsAt = stop?.resetsAt
  return <p className="continue-composer-note tt-paragraph"><CornerDownRight size={13} aria-hidden="true" />
    <span>{resetsAt && owner ? t`Continued in a ${provider} thread. You can still send here once ${owner}’s limit resets at ${resetsAt}.` : t`Continued in a ${provider} thread. You can still send here.`}</span></p>
}
