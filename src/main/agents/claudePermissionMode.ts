import type { AgentRuntimeMode } from '../../shared/agents'
import { RUNTIME_MODE_WORDS } from '../../shared/workerRoles'

/** Claude Code's `--permission-mode` for each of Sotto's modes. Aliases without a stored mode run approval-required. */
export const nativePermissionModes = { 'approval-required': 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' } as const satisfies Record<AgentRuntimeMode, string>

/**
 * Claude Code's permission modes from strictest to loosest (#657, ADR-0043 amended November 6, 2026): how much a session
 * does without asking. `plan` runs nothing, `dontAsk` turns down whatever is not already allowed and asks nobody,
 * `default` asks, `acceptEdits` edits without asking, `auto` lets Claude Code's own classifier allow commands too, and
 * `bypassPermissions` asks about almost nothing. `manual` is the CLI's other name for `default`.
 */
const STRICTNESS: Readonly<Record<string, number>> = { plan: 0, dontAsk: 1, default: 2, manual: 2, acceptEdits: 3, auto: 4, bypassPermissions: 5 }

/** A mode Claude Code reports, in the words the thread's permission control uses, or the CLI's own name for it. */
const NATIVE_WORDS: Readonly<Record<string, string>> = { default: RUNTIME_MODE_WORDS['approval-required'], manual: RUNTIME_MODE_WORDS['approval-required'],
  acceptEdits: RUNTIME_MODE_WORDS['auto-accept-edits'], auto: RUNTIME_MODE_WORDS.auto, bypassPermissions: RUNTIME_MODE_WORDS['full-access'],
  plan: 'plan mode', dontAsk: 'don’t-ask mode' }

/**
 * How the mode a session's `system`/`init` frame reports compares with the one the thread shows: `looser` when it does
 * more without asking, `stricter` when it does less, undefined when they agree or the frame names no mode, which an older
 * CLI's may not and which says nothing either way. A mode Sotto cannot rank is one it cannot vouch for, so it reads as looser.
 */
export function permissionModeDrift(shown: AgentRuntimeMode, reported: unknown): 'looser' | 'stricter' | undefined {
  if (typeof reported !== 'string') return undefined
  const expected = STRICTNESS[nativePermissionModes[shown]]!
  const actual = Object.hasOwn(STRICTNESS, reported) ? STRICTNESS[reported]! : Number.POSITIVE_INFINITY
  return actual > expected ? 'looser' : actual < expected ? 'stricter' : undefined
}

const reportedWords = (reported: string): string => Object.hasOwn(NATIVE_WORDS, reported) ? NATIVE_WORDS[reported]! : 'a permission mode Sotto does not know'

/**
 * The failed turn's words when Claude Code started looser than the thread shows: Sotto stopped it, and nothing from this
 * message ran, once its whole process tree was seen gone (`confirmed`). Background work an earlier message started ended
 * with it, so it is named, with how to get it back (ADR-0023).
 */
export function looserModeStopped(shown: AgentRuntimeMode, reported: string, stop: { ended?: readonly { label: string }[]; confirmed?: boolean } = {}): string {
  const ended = stop.ended ?? []
  const what = ended.length === 1 ? `"${ended[0]!.label}"` : `${ended.length} background tasks`
  const them = ended.length === 1 ? 'it' : 'them'
  const head = `Claude Code started in ${reportedWords(reported)} although this thread is set to ${RUNTIME_MODE_WORDS[shown]}`
  const outcome = stop.confirmed === false
    ? `${head}, so Sotto stopped it, but could not confirm that it ended, so it may have acted. Check the project for changes.`
    : ended.length ? `${head}, so Sotto stopped it before it acted. Nothing from this message ran, and ${what}, started earlier, stopped with it.`
      : `${head}, so Sotto stopped it before it acted. Nothing ran.`
  const restart = ended.length ? ` Ask Claude to start ${them} again if you still need ${them}.` : ''
  return `${outcome} Something between Sotto and Claude Code changed the mode, such as a wrapper script named claude on your PATH or Claude Code’s managed settings. Fix that, then send your message again.${restart}`
}

/** The one-line note when Claude Code runs stricter than the thread shows; the turn carries on. */
export const stricterModeNote = (shown: AgentRuntimeMode, reported: string): string =>
  `Claude Code is running in ${reportedWords(reported)}, which is stricter than this thread’s ${RUNTIME_MODE_WORDS[shown]}, so it may ask or refuse more than you chose.`
