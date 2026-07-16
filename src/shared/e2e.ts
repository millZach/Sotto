import { z } from 'zod'

export const E2E_TRANSCRIPT = 'A deterministic local transcript.'
export const E2E_PRESERVED_CLIPBOARD = 'Clipboard text that must survive silence.'
export const E2E_CONFLICTING_HOTKEY = 'Ctrl+Alt+9'
export const E2E_SNAPSHOT_CHANNEL = 'talktype:e2e:snapshot'
export const E2E_TRIGGER_SHORTCUT_CHANNEL = 'talktype:e2e:trigger-shortcut'

export const e2eScenarioSchema = z.enum([
  'success',
  'history-disabled',
  'hotkey-conflict',
  'microphone-denied-once',
  'silence',
  'paste-failure',
  'transcription-failure',
])

export const e2eSnapshotSchema = z.object({
  clipboardText: z.string(),
  pasteAttempts: z.number().int().nonnegative(),
  mainVisible: z.boolean(),
}).strict()

export type E2EScenario = z.infer<typeof e2eScenarioSchema>
export type E2ESnapshot = z.infer<typeof e2eSnapshotSchema>

export interface TalkTypeE2EBridge {
  readonly scenario: E2EScenario
  snapshot(): Promise<E2ESnapshot>
  triggerShortcut(): Promise<void>
}
