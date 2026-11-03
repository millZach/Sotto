import { z } from 'zod'

export const recoveryNoticeSchema = z
  .object({
    code: z.enum([
      'SETTINGS_RECOVERED',
      'OPENROUTER_KEY_MIGRATION_FAILED',
      'HISTORY_RECOVERED',
      'CREDENTIALS_RECOVERED',
      'ACCESSIBILITY_PERMISSION_REQUIRED',
      'AUTOMATION_PERMISSION_REQUIRED',
      'DESKTOP_CLIPBOARD_UNAVAILABLE',
      'OPENROUTER_KEY_UNREADABLE',
      'RETIRED_CHAT_HISTORY_NOT_CLEARED',
      'ANSWER_HISTORY_NOT_CLEARED',
      'REMOTE_DRAFT_STORAGE_NOT_UPDATED',
      'REMOTE_DRAFTS_UNREADABLE',
    ]),
  })
  .strict()

export type RecoveryNotice = z.infer<typeof recoveryNoticeSchema>

export const pastePermissionNoticeCodeSchema = z.enum([
  'ACCESSIBILITY_PERMISSION_REQUIRED',
  'AUTOMATION_PERMISSION_REQUIRED',
])
export type PastePermissionNoticeCode = z.infer<typeof pastePermissionNoticeCodeSchema>

export function isPastePermissionNotice(code: RecoveryNotice['code']): code is PastePermissionNoticeCode {
  return code === 'ACCESSIBILITY_PERMISSION_REQUIRED' || code === 'AUTOMATION_PERMISSION_REQUIRED'
}

// An explicit false starts a new permission failure; retained snapshots carry only the code.
export const recoveryNoticeEventSchema = recoveryNoticeSchema.extend({ cleared: z.boolean().optional() })
export type RecoveryNoticeEvent = z.infer<typeof recoveryNoticeEventSchema>

export const recoveryNoticesSchema = z
  .array(recoveryNoticeSchema)
  .max(recoveryNoticeSchema.shape.code.options.length)
  .transform((notices) =>
    Object.freeze(notices.map((notice) => Object.freeze(notice))),
  )
