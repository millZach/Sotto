import { isAbsolute, join } from 'node:path'

/** The only operations a compositor binding may send. No text or audio crosses this socket. */
export type CompositorDictationCommand = 'start' | 'stop' | 'toggle' | 'cancel'

export interface DictationRequest {
  readonly command: CompositorDictationCommand
  readonly at?: bigint
}

/** Epoch nanoseconds from the binding, before the client boots. */
export const DICTATION_STAMP_MAX_AGE_NS = 5_000_000_000n
export const DICTATION_STAMP_FUTURE_SKEW_NS = 250_000_000n
export const DICTATION_REQUEST_MAX_BYTES = 40

export function parseDictationCommand(value: string): CompositorDictationCommand | null {
  return value === 'start' || value === 'stop' || value === 'toggle' || value === 'cancel' ? value : null
}

export function parseDictationArguments(args: readonly string[]): DictationRequest | null {
  if (args[0] !== 'dictation' || (args.length !== 2 && args.length !== 4)) return null
  const command = parseDictationCommand(args[1]!)
  if (command === null) return null
  if (args.length === 2) return { command }
  if (args[2] !== '--at' || !/^[1-9][0-9]{0,19}$/.test(args[3]!)) return null
  return { command, at: BigInt(args[3]!) }
}

export function parseDictationRequest(value: string): DictationRequest | null {
  return parseDictationArguments(['dictation', ...value.split(' ')])
}

export function dictationSocketPath(runtimeDirectory: string | undefined): string {
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error('Dictation needs XDG_RUNTIME_DIR.')
  return join(runtimeDirectory, 'sotto', 'dictation.sock')
}
