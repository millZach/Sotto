import { z } from 'zod'

export const E2E_TRANSCRIPT = 'A deterministic local transcript.'
/**
 * Scripted E2E dictations stamp their history entry with this instead of the
 * wall clock, so design captures render one constant date label rather than
 * the minute the suite happened to run. Kept in the fixture era (July 2026,
 * older than a week) so the entry also stays out of the weekly stats tiles.
 */
export const E2E_HISTORY_CREATED_AT = Date.UTC(2026, 6, 12, 19, 30)
export const E2E_PRESERVED_CLIPBOARD = 'Clipboard text that must survive silence.'
export const E2E_CONFLICTING_HOTKEY = 'Ctrl+Alt+9'
export const E2E_SNAPSHOT_CHANNEL = 'sotto:e2e:snapshot'
export const E2E_TRIGGER_SHORTCUT_CHANNEL = 'sotto:e2e:trigger-shortcut'

export const e2eScenarioSchema = z.enum([
  'success',
  'history-disabled',
  'hotkey-conflict',
  'microphone-denied-once',
  'silence',
  'paste-failure',
  'transcription-failure',
  'design-permission',
  'design-processing',
])

export const e2eSnapshotSchema = z.object({
  clipboardText: z.string(),
  pasteAttempts: z.number().int().nonnegative(),
  mainVisible: z.boolean(),
}).strict()

export type E2EScenario = z.infer<typeof e2eScenarioSchema>
export type E2ESnapshot = z.infer<typeof e2eSnapshotSchema>

export interface SottoE2EBridge {
  readonly scenario: E2EScenario
  snapshot(): Promise<E2ESnapshot>
  triggerShortcut(): Promise<void>
}
