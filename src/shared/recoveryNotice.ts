import { z } from 'zod'

export const recoveryNoticeSchema = z
  .object({
    code: z.enum(['SETTINGS_RECOVERED', 'HISTORY_RECOVERED']),
  })
  .strict()

export type RecoveryNotice = z.infer<typeof recoveryNoticeSchema>

export const recoveryNoticesSchema = z
  .array(recoveryNoticeSchema)
  .max(2)
  .transform((notices) =>
    Object.freeze(notices.map((notice) => Object.freeze(notice))),
  )
