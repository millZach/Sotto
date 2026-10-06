import { z } from 'zod'

/** The macOS Privacy & Security panes Sotto can open for a permission it needs. */
export const systemSettingsPaneSchema = z.enum(['microphone', 'accessibility', 'automation'])

export type SystemSettingsPane = z.infer<typeof systemSettingsPaneSchema>
