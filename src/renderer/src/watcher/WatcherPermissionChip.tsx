import React, { useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentRuntimeModeSchema, type AgentModel, type AgentRuntimeMode } from '../../../shared/agents'
import { ChoiceChip, permissionInForceCaption, RUNTIME_LABELS, WatcherPermission, type ChoiceOption } from '../agents/ThreadOptions'
import { useWatcherRoom } from './watcherRoom'

/** The chip's name, which says which setting a press changes. */
export const WATCHER_PERMISSIONS = 'Watcher’s permissions'
/** What stays true in every mode, under the list (the approved mock-up, control A). */
export const WATCHER_PERMISSIONS_FOOT = 'When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread.'
/** What a new Watcher starts on the first time ever; after that, the mode the user last chose. */
const FIRST_MODE: AgentRuntimeMode = 'approval-required'

/** Each mode in one line, as what Watcher does under it; Auto is the provider's own judgement, so it names the provider. */
export function watcherModeDescriptions(provider: string): Record<AgentRuntimeMode, string> {
  return {
    'approval-required': 'Asks you before it edits a file or runs a command that changes something.',
    'auto-accept-edits': 'Edits files without asking. Asks before a command that changes something.',
    auto: `${provider} decides what to ask you about.`,
    'full-access': 'Edits files and runs any command without asking, anywhere on this computer.',
  }
}

/**
 * The modes Watcher's model offers, each with its line, led by the chosen mode as unchoosable when the model does not
 * offer it (a Grok Build model offers three). A model that lists none offers Sotto's four.
 */
function choices(model: AgentModel | undefined, chosen: AgentRuntimeMode, provider: string): ChoiceOption[] {
  const offered = model?.runtimeModes?.length ? model.runtimeModes : agentRuntimeModeSchema.options
  const lines = watcherModeDescriptions(provider)
  const lead = offered.includes(chosen) ? [] : [{ id: chosen, label: RUNTIME_LABELS[chosen], disabled: true }]
  return [...lead, ...offered.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode], description: lines[mode] }))]
}

/**
 * What Watcher may do without asking, chosen in its composer after its model and reasoning, as a thread's permissions
 * are on Threads (Zach's pick on October 13, 2026, control A). The choice is Watcher's own: main remembers it, a new
 * Watcher starts on it, and the first ever starts on Ask for approval. A press shows at once; until the provider confirms
 * it for the current Watcher, the chip is dashed and the caption beside it says what is still in force, as on Threads. A
 * refusal is said in main's words under the chips. Where the room's bridge cannot change it, the mode is said as a fact.
 */
export function WatcherPermissionChip({ model, provider, inForce, disabled = false, noticeSlot }: {
  readonly model: AgentModel | undefined
  /** The provider's name, for Auto's line and the caption. */
  readonly provider: string
  /** The mode the current Watcher's thread reports, where the room's projection does not say. */
  readonly inForce?: AgentRuntimeMode | undefined
  readonly disabled?: boolean
  /** Where the composer wants a refusal said, under its whole footer row. */
  readonly noticeSlot?: HTMLElement | null | undefined
}): ReactNode {
  const room = useWatcherRoom()
  const captionId = useId()
  const [pressed, setPressed] = useState<AgentRuntimeMode | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const state = room?.state ?? null
  const remembered = state?.runtimeMode ?? state?.currentOptions?.runtimeMode ?? FIRST_MODE
  const chosen = pressed ?? remembered
  if (room === null || room.setPermission === null) return <WatcherPermission mode={state?.currentOptions?.runtimeMode ?? inForce ?? remembered} />
  const setPermission = room.setPermission
  // In force: the current Watcher's own mode. Before Watcher exists nothing is in force, so nothing waits.
  const current = state?.current == null ? undefined : state.currentOptions?.runtimeMode ?? inForce
  const pending = current !== undefined && chosen !== current
  const choose = async (mode: AgentRuntimeMode): Promise<void> => {
    if (mode === chosen) return
    setPressed(mode)
    setRefusal(null)
    try {
      setRefusal(room.settle(await setPermission({ runtimeMode: mode })))
    } catch {
      setRefusal(`Sotto could not reach Watcher to change its permissions. It stays on ${RUNTIME_LABELS[remembered]}.`)
    } finally {
      setPressed(null)
    }
  }
  const notice = refusal === null ? null : <p className="thread-options__notice" role="alert"><span>{refusal}</span></p>
  return <>
    <ChoiceChip label={WATCHER_PERMISSIONS} placeholder={RUNTIME_LABELS[FIRST_MODE]} value={chosen} options={choices(model, chosen, provider)}
      disabled={disabled} pending={pending} describedBy={captionId} foot={WATCHER_PERMISSIONS_FOOT}
      onChange={mode => void choose(mode as AgentRuntimeMode)} />
    {/* Always present, so assistive technology hears the caption when it arrives. */}
    <span id={captionId} className="thread-options__caption" role="status">{pending ? permissionInForceCaption(provider, { runtimeMode: current }) : ''}</span>
    {noticeSlot ? createPortal(notice, noticeSlot) : notice}
  </>
}
