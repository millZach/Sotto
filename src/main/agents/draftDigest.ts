import { createHash } from 'node:crypto'
import type { AgentCommand } from '../../shared/agents'

/**
 * An explicit revision owns one immutable Send packet, including after a lost reply or restart: the digest of what the
 * packet carries, its thread, words, pictures and the question it answers. Taken out of `control.ts` (ADR-0190).
 */
export function atomicDraftDigest(draft: NonNullable<Extract<AgentCommand, { type: 'send' }>['draft']>): string {
  return createHash('sha256').update(JSON.stringify([draft.threadId, draft.text, draft.attachments === undefined ? null : draft.attachments.map(image => [image.id, image.name, image.mimeType, image.sizeBytes, image.digest]),
    draft.binding ? [draft.binding.requestId, draft.binding.questionsDigest] : null])).digest('hex')
}
