import { z } from 'zod'

/** History-owned reply metadata. Never placed in Watcher's text-free control record. */
export const watcherOwnChangeSchema = z.object({ replyMessageId: z.string().min(1).max(512),
  turnId: z.string().min(1).max(512), files: z.array(z.string().min(1).max(4_096)),
  fileCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().max(2_000).nullable(), source: z.literal('provider-file-change') }).strict()
export type WatcherOwnChange = z.infer<typeof watcherOwnChangeSchema>
/** Successful edit evidence retained at the exact user-message turn anchor until a final reply exists. */
export const watcherObservedChangesSchema = z.array(z.object({ turnId: z.string().min(1).max(512),
  files: z.array(z.string().min(1).max(4_096)) }).strict())
