import type { HandoverCounts } from './agents'

/**
 * A **handover**'s words both processes need (CONTEXT.md): how every handover begins, which a copy that splits one from
 * the user's words checks first, and what one carried and left out, said from its counts alone. Main builds the
 * handover itself (`src/main/agents/handover.ts`).
 */

/** The first words of every handover. */
export const HANDOVER_LEAD = 'This is a handover from another Sotto thread.'

/** What a handover carried and left out, in words, from its counts alone. */
export function handoverLedger(counts: HandoverCounts): { readonly carried: string; readonly leftOut: string | null } {
  const amount = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
  const listed = (items: readonly string[]): string => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`
  const carried = counts.carried === counts.total
    ? counts.total === 1 ? 'its one message' : `all ${amount(counts.total, 'message')}`
    : `${counts.carried.toLocaleString('en-US')} of ${amount(counts.total, 'message')}`
  const left = [
    counts.tooLong > 0 ? `${amount(counts.tooLong, 'message')} too long to carry` : '',
    counts.notCarried > 0 ? `${amount(counts.notCarried, 'older message')} that did not fit` : '',
    counts.images > 0 ? amount(counts.images, 'image') : '',
    counts.files > 0 ? amount(counts.files, 'attached file') : '',
    counts.visuals > 0 ? amount(counts.visuals, 'visual') : '',
    counts.toolRecords > 0 ? `${amount(counts.toolRecords, 'record')} of its work` : '',
  ].filter(Boolean)
  return { carried, leftOut: left.length > 0 ? listed(left) : null }
}
