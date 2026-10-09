import { isAbsolute, join } from 'node:path'
import type { WidgetEdge } from '../windows/widgetPlacementMath'

/** The only operations a compositor binding may send. No text or audio crosses this socket. */
export type CompositorDictationCommand = 'start' | 'stop' | 'toggle' | 'cancel' | 'retry' | 'discard' | `place ${WidgetEdge}`

export interface DictationRequest {
  readonly command: CompositorDictationCommand
  readonly at?: bigint
}

/** Epoch nanoseconds from the binding, before the client boots. */
export const DICTATION_STAMP_MAX_AGE_NS = 5_000_000_000n
export const DICTATION_STAMP_FUTURE_SKEW_NS = 250_000_000n
export const DICTATION_REQUEST_MAX_BYTES = 40

export function parseDictationEdge(value: string): WidgetEdge | null {
  return value === 'top' || value === 'bottom' || value === 'left' || value === 'right' ? value : null
}

export function parseDictationCommand(value: string): CompositorDictationCommand | null {
  if (value === 'start' || value === 'stop' || value === 'toggle' || value === 'cancel' || value === 'retry' || value === 'discard') return value
  const edge = value.startsWith('place ') ? parseDictationEdge(value.slice(6)) : null
  return edge === null ? null : `place ${edge}`
}

export function parseDictationArguments(args: readonly string[]): DictationRequest | null {
  if (args[0] !== 'dictation' || args[1] === undefined || args[1].includes(' ')) return null
  const verbLength = args[1] === 'place' ? 3 : 2
  if (args.length !== verbLength && args.length !== verbLength + 2) return null
  const command = parseDictationCommand(args.slice(1, verbLength).join(' '))
  if (command === null) return null
  if (args.length === verbLength) return { command }
  if (args[verbLength] !== '--at' || !/^[1-9][0-9]{0,19}$/.test(args[verbLength + 1]!)) return null
  return { command, at: BigInt(args[verbLength + 1]!) }
}

export function parseDictationRequest(value: string): DictationRequest | null {
  return parseDictationArguments(['dictation', ...value.split(' ')])
}

export function dictationSocketPath(runtimeDirectory: string | undefined): string {
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error('Dictation needs XDG_RUNTIME_DIR.')
  return join(runtimeDirectory, 'sotto', 'dictation.sock')
}
