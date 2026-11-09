import React, { type ReactNode } from 'react'
import { Lock, Shield } from 'lucide-react'
import { msg, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, THREAD_SETTINGS_UNRECONCILED, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'
import { ULTRACODE } from '../../../shared/ultracode'
import type { ChoiceOption } from './ChoiceChip'
import { wordsOf } from './interfaceWords'
import './threadChips.css'

export const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = wordsOf({
  'approval-required': msg({ message: 'Ask for approval', comment: 'A permission mode: the agent asks before it acts.' }),
  'auto-accept-edits': msg({ message: 'Allow edits', comment: 'A permission mode: the agent edits files without asking.' }),
  auto: msg({ message: 'Auto', comment: 'A permission mode: the agent decides what to ask about.' }),
  'full-access': msg({ message: 'Full access', comment: 'A permission mode: the agent runs anything without asking.' }),
})
/**
 * What each of Cursor's three modes does, said as Cursor doing it (ADR-0128), in the interface language. Cursor has no
 * Allow edits: it edits inside the project without asking under every mode, so Ask for approval says so, and Auto says
 * where its judgement runs.
 */
export function cursorModeLine(mode: AgentRuntimeMode): string | undefined {
  switch (mode) {
    case 'approval-required': return t`Cursor asks before commands, web requests and tools. It edits files inside the project without asking.`
    case 'auto': return t`Cursor’s own auto-review decides what runs without asking. Its classifier runs on Cursor’s servers; what it holds back comes to you.`
    case 'full-access': return t`Cursor runs commands, web requests and tools and edits files without asking, in the project and outside it.`
    default: return undefined
  }
}
/**
 * What each of DeepSeek Harness's three modes does, said as the harness doing it (ADR-0138), in the interface
 * language. Its permissions are a sandbox boundary: Ask for approval denies a first attempt and the model asks to
 * retry it, and Allow edits also lets commands and network run inside the sandbox, so both say so.
 */
export function deepseekModeLine(mode: AgentRuntimeMode): string | undefined {
  switch (mode) {
    case 'approval-required': return t`DeepSeek Harness denies a first write or command and the model then asks you to allow the retry. A model that does not ask simply fails the write.`
    case 'auto-accept-edits': return t`DeepSeek Harness edits, runs commands and uses the network inside the workspace sandbox without asking. It asks before anything crosses that boundary.`
    case 'full-access': return t`DeepSeek Harness runs commands and edits files without asking, in the project and outside it.`
    default: return undefined
  }
}
/**
 * What each of Codex's four modes does, said as Codex doing it (ADR-0005, Zach's pick on November 4, 2026), in the
 * interface language. The words are Codex 0.166.0's behaviour under `runtimePolicy` in `src/main/agents/codex.ts`:
 * Ask for approval is `untrusted` in a read-only sandbox, where even a command that only reads asks unless the user's
 * own Codex rules allow it (#2185); Allow edits is
 * `on-request` in `workspace-write`, where commands inside the project run unasked and the network, other folders and
 * `.git` need escalation; Auto routes those escalations to Codex's `auto_review` reviewer, a model on the thread's own
 * model provider, which Sotto sets to OpenAI; Full access is `never` with no sandbox. Read them again when Codex or that
 * mapping changes. A thread on another computer names it under Full access, since "this computer" is the one Sotto runs on.
 */
export function codexModeLine(mode: AgentRuntimeMode, computer?: string): string {
  if (mode === 'full-access' && computer) return t({ message: `Codex runs any command and edits any file without asking, anywhere on ${computer} and online.`, comment: '{computer} is the name of the computer the thread runs on, such as forge.' })
  switch (mode) {
    case 'approval-required': return t`Codex asks before every edit, and before every command your Codex rules don’t already allow, even one that only reads.`
    case 'auto-accept-edits': return t`Codex edits files and runs commands in the project without asking. It asks before going online, outside the project or committing.`
    case 'auto': return t`As Allow edits, but Codex’s own reviewer, a model run by OpenAI, answers what would come to you.`
    case 'full-access': return t`Codex runs any command and edits any file without asking, anywhere on this computer and online.`
  }
}
/** Permissions' glyph, which stands for the value in a narrow composer. */
export const PERMISSIONS_ICON = <Shield size={14} aria-hidden="true" />
const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/** The choices used when creating a thread, visible while its optional controls are collapsed. */
export function threadOptionsSummary(model: AgentModel | undefined, effort: string | undefined, mode: AgentRuntimeMode | undefined, providerMode?: string): string {
  const reasoning = effort ?? model?.defaultReasoningEffort
  const own = model?.providerModes?.find(candidate => candidate.id === startingProviderMode(model, providerMode))
  const permissions = own ? own.name : mode ? RUNTIME_LABELS[mode] : t`Provider default`
  return [model?.name ?? t`Choose model`, reasoning ? capitalise(reasoning) : null, permissions].filter(Boolean).join(' · ')
}

/**
 * Watcher's permission mode said as a fact, where its room's bridge offers no way to change it: an older stand-in, or
 * a build whose main does not take the choice yet. Where it does, `WatcherPermissionChip` stands here instead.
 */
export function WatcherPermission({ mode = 'approval-required' }: { readonly mode?: AgentRuntimeMode | undefined }): ReactNode {
  const { t } = useLingui()
  return <span className="thread-options__pinned" title={t`This Sotto cannot change what Watcher may do without asking.`}>
    <Lock size={13} aria-hidden="true" /><span className="tt-visually-hidden">{t`Watcher’s permissions:`}{' '}</span>{RUNTIME_LABELS[mode]}</span>
}

/**
 * The effort levels a model offers, led by the current one as unchoosable when the model does not offer it. Ultracode
 * is offered only where a person picks a thread's own effort (`ultracode`), never for Watcher or a worker role (ADR-0148).
 */
export function effortChoices(model: AgentModel | undefined, reasoning: string, { ultracode = false }: { readonly ultracode?: boolean } = {}): ChoiceOption[] {
  const efforts = (model?.reasoningEfforts ?? []).filter(effort => ultracode || effort !== ULTRACODE)
  if (efforts.length === 0) return []
  const lead = efforts.includes(reasoning) ? [] : [{ id: reasoning, label: reasoning ? capitalise(reasoning) : t`Provider default`, disabled: true }]
  return [...lead, ...efforts.map(effort => ({ id: effort, label: capitalise(effort) }))]
}

/**
 * The permission modes a model offers, led by "Provider default" or an unoffered current mode as
 * unchoosable. A provider whose modes are its own (Devin) answers with those instead of Sotto's four, and
 * each carries what Sotto will still ask about under it, so a mode named for what the provider stops
 * asking cannot be read as Sotto stopping too. `computer` names the thread's computer when it is not this one.
 */
export function modeChoices(model: AgentModel | undefined, runtimeMode: AgentRuntimeMode | undefined, providerMode: string | undefined, computer?: string): ChoiceOption[] {
  const own = model?.providerModes ?? []
  if (own.length > 0) {
    // Unchosen reads as the first mode, which is what the thread starts on, so only an unoffered one leads.
    const lead = providerMode === undefined || own.some(mode => mode.id === providerMode) ? [] : [{ id: providerMode, label: providerMode, disabled: true }]
    return [...lead, ...own.map(mode => ({ id: mode.id, label: mode.name,
      ...(mode.description || mode.asks ? { description: [mode.description, mode.asks].filter(Boolean).join(' ') } : {}) }))]
  }
  const modes = model?.runtimeModes ?? []
  if (modes.length === 0) return []
  const lead = runtimeMode === undefined ? [{ id: '', label: t`Provider default`, disabled: true }]
    : modes.includes(runtimeMode) ? [] : [{ id: runtimeMode, label: RUNTIME_LABELS[runtimeMode], disabled: true }]
  return [...lead, ...modes.map(mode => {
    const line = model?.providerId === 'cursor' ? cursorModeLine(mode) : model?.providerId === 'deepseek' ? deepseekModeLine(mode)
      : model?.providerId === 'codex' ? codexModeLine(mode, computer) : undefined
    return { id: mode, label: RUNTIME_LABELS[mode], ...(line ? { description: line, translated: true } : {}) }
  })]
}
/** The provider mode a thread is on, or the one it starts on when none has been chosen: the first offered. */
export const startingProviderMode = (model: AgentModel | undefined, providerMode: string | undefined): string | undefined =>
  providerMode ?? model?.providerModes?.[0]?.id

/**
 * The caption beside the chips while a permission change waits: what is still in force, in the provider's name. What a
 * permission mode still lets the provider do is said as the provider doing it: the difference decides what the
 * provider does on its next tool call, so the caption names the mode in force rather than the one coming. Under Codex's
 * Auto a reviewer model answers in the user's place (#2161), so for Codex that caption says so.
 */
export function permissionInForceCaption(provider: string, inForce: { readonly runtimeMode?: AgentRuntimeMode | undefined; readonly providerModeName?: string | undefined }, providerId?: string): string {
  const mode = inForce.providerModeName
  if (mode) return t({ message: `${provider} stays on ${mode} until it confirms.`, comment: '{provider} is a provider\'s name or "The provider"; {mode} is the provider\'s own name for a permission mode.' })
  if (providerId === 'codex' && inForce.runtimeMode === 'auto') return t`Codex’s reviewer still answers what would come to you until it confirms.`
  switch (inForce.runtimeMode) {
    case 'approval-required': return t({ message: `${provider} still asks for approval until it confirms.`, comment: '{provider} is a provider\'s name or "The provider".' })
    case 'auto-accept-edits': return t({ message: `${provider} still makes edits without asking until it confirms.`, comment: '{provider} is a provider\'s name or "The provider".' })
    case 'auto': return t({ message: `${provider} still decides what to ask you about until it confirms.`, comment: '{provider} is a provider\'s name or "The provider".' })
    case 'full-access': return t({ message: `${provider} still runs anything without asking until it confirms.`, comment: '{provider} is a provider\'s name or "The provider".' })
    default: return t({ message: `${provider} keeps its own default until it confirms.`, comment: '{provider} is a provider\'s name or "The provider".' })
  }
}

/**
 * The alert under the chips after a press the provider did not take, which puts the chip back and offers Try again.
 * A plain refusal is main's `PROVIDER_REJECTED_ACTION`, with nothing left to reconcile, so it can say nothing else
 * changed. Any other sentence is main's or the provider's own reason, shown as it is with nothing claimed beside it.
 * No answer at all leaves the chip on what the thread last reported, and Try again sends the choice once more.
 */
export function settingRefusalText(provider: string, wanted: string, inForce: string, error: string | null): string {
  if (error === null) return t({ message: `Sotto did not get ${provider}'s answer about ${wanted}, so the chip shows what the thread last reported. Try again to send it once more.`, comment: '{provider} is a provider\'s name or "The provider"; {wanted} is the chosen model, effort or permission mode.' })
  if (error === PROVIDER_REJECTED_ACTION) return t({ message: `${provider} did not switch to ${wanted}. The thread stays on ${inForce}; nothing else changed.`, comment: '{provider} is a provider\'s name or "The provider"; {wanted} and {inForce} are a model, effort or permission mode.' })
  return t({ message: `${provider} did not switch to ${wanted}. ${error}`, comment: '{error} is the provider\'s or Sotto\'s own reason, shown as it came.' })
}

/**
 * The line under the chips when the provider never gave a result. Main keeps the change for the thread's next start
 * and the chip keeps showing it, so this says what happened and what comes next, and offers nothing to press: main
 * takes no other action on the thread until it knows. The provider's own account (a lost answer that stopped the
 * session, and what stopped with it) already names the provider and says what happened, so it is shown alone; main's
 * general one is put in plain words.
 */
export function unconfirmedSettingText(provider: string, wanted: string, error: string | null, inForce?: string): string {
  if (error === null || error === PROVIDER_RESULT_UNCONFIRMED || error === THREAD_SETTINGS_UNRECONCILED) {
    // A model or effort with no result holds nothing back, so a turn can run on the one before it meanwhile (#1192).
    if (inForce !== undefined && inForce !== wanted) return t({ message: `${provider} has not confirmed ${wanted}. Until it does, a turn can still run on ${inForce}.`, comment: '{provider} is a provider\'s name or "The provider"; {wanted} and {inForce} are a model, effort or permission mode.' })
    return t({ message: `${provider} has not confirmed ${wanted}. The thread starts on ${wanted} the next time it is used, and Sotto checks it then.`, comment: '{provider} is a provider\'s name or "The provider"; {wanted} is a model, effort or permission mode.' })
  }
  return error
}

/**
 * Whether a prompt on this thread is on its way to the provider, which a settings change would have to wait behind. One
 * the user set aside is not: Sotto never sends it again, whatever became of it (#1156).
 */
export const promptOnItsWay = (state: AgentState, threadId: string): boolean =>
  state.deliveries?.some(delivery => delivery.threadId === threadId && !delivery.setAside
    && (delivery.status === 'queued' || delivery.status === 'submitting' || delivery.status === 'uncertain')) === true

/** Why Watcher's permissions are fixed now, as a thread's are while it works: main refuses a change until then. */
export function watcherPermissionFixedReason(state: AgentState, thread: AgentThread): string | undefined {
  return thread.status === 'running' || thread.requests.length > 0 || promptOnItsWay(state, thread.id)
    ? t`Fixed while Watcher works. It can change once Watcher finishes and nothing waits on you.` : undefined
}
