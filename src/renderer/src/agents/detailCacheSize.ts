import type { AgentThreadDetail } from '../../../shared/agents'

/**
 * Roughly how much memory the histories a window holds take, for the development console. Two bytes a
 * string character, eight a number, four a boolean, and nothing for object headers or shared strings, so
 * the figure is for comparing one session with another rather than for reading as the heap.
 *
 * A streamed chunk replaces only the message it grew and the activity records that moved; every other
 * record keeps its identity, so each record is measured once and remembered until it is dropped.
 */
const measured = new WeakMap<object, number>()

export function approximateDetailBytes(details: Iterable<AgentThreadDetail>): number {
  let total = 0
  for (const detail of details) {
    for (const message of detail.messages) total += record(message)
    for (const activity of detail.activities ?? []) total += record(activity)
  }
  return total
}

function record(value: object): number {
  const known = measured.get(value)
  if (known !== undefined) return known
  const size = approximateBytes(value)
  measured.set(value, size)
  return size
}

function approximateBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2
  if (typeof value === 'number') return 8
  if (typeof value === 'boolean') return 4
  if (value === null || typeof value !== 'object') return 0
  let total = 0
  if (Array.isArray(value)) { for (const item of value) total += approximateBytes(item); return total }
  for (const [key, item] of Object.entries(value)) total += key.length * 2 + approximateBytes(item)
  return total
}
