import { isAbsolute, join } from 'node:path'

/** The only operations a compositor binding may send. No text or audio crosses this socket. */
export type CompositorDictationCommand = 'start' | 'stop' | 'toggle' | 'cancel'

export function parseDictationCommand(value: string): CompositorDictationCommand | null {
  return value === 'start' || value === 'stop' || value === 'toggle' || value === 'cancel' ? value : null
}

export function parseDictationArguments(args: readonly string[]): CompositorDictationCommand | null {
  return args.length === 2 && args[0] === 'dictation' ? parseDictationCommand(args[1]!) : null
}

export function dictationSocketPath(runtimeDirectory: string | undefined): string {
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error('Dictation needs XDG_RUNTIME_DIR.')
  return join(runtimeDirectory, 'sotto', 'dictation.sock')
}
